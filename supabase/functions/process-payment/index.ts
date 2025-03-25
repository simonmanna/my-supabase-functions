import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.167.0/crypto/mod.ts";

// Types

interface MenuOption {
  id: string;
  name: string;
  price_adjustment: number;
}

interface OrderItemOption {
  id: string;
  name: string;
  value: string;
}

interface Addon {
  id: string; // UUID
  name: string;
  price: number;
}

interface MenuItem {
  id: number;
  price: number;
  name: string;
}

interface OrderItem {
  id: number;
  name: string;
  quantity: number;
  selectedAddons?: Addon[];
  selectedOptionDetails?: OrderItemOption[];
  special_instructions?: string;
  is_gluten_free?: boolean;
  is_vegetarian?: boolean;
  is_vegan?: boolean;
  requires_special_preparation?: boolean;
}

interface OrderItemAddon {
  addon_id: string;
  quantity: number;
}

interface DeliveryLocation {
  address: string;
  latitude: number;
  longitude: number;
}

interface OrderRequest {
  order_items: OrderItem[];
  user_id: string;
  total_amount: number;
  vat: number;
  total_amount_vat: number;
  status: string;
  phone_number: string;
  delivery_method: string;
  payment_method: string;
  delivery_person_id: number; // Changed from string to number
  created_at: string;
  order_note?: string;
  delivery_address: string;
  delivery_location?: DeliveryLocation;
  delivery_longitude?: number;
  delivery_latitude?: number;
}

interface NotificationData {
  user_id: string;
  order_id: number;
  title: string;
  body: string;
  type: string;
  is_read: boolean;
}

// Add this function to create a notification
async function createNotification(
  supabaseClient: any,
  userId: string,
  orderId: number,
  title: string,
  body: string,
  type: string = "ORDER_STATUS"
): Promise<any> {
  try {
    const { data, error } = await supabaseClient
      .from("notifications")
      .insert({
        user_id: userId,
        order_id: orderId,
        title,
        body,
        type,
        is_read: false,
        created_at: new Date().toISOString(),
      })
      .select();

    if (error) {
      console.error("Error creating notification:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
}

async function createOrderWithItems(orderRequest: OrderRequest) {
  const {
    order_items,
    user_id,
    status,
    phone_number,
    delivery_method,
    payment_method,
    delivery_person_id,
    order_note,
    delivery_address,
    delivery_location,
    delivery_longitude,
    delivery_latitude,
  } = orderRequest;

  let deliveryLocationGeog = null;
  if (delivery_longitude && delivery_latitude) {
    deliveryLocationGeog = `POINT(${delivery_longitude} ${delivery_latitude})`;
  }

  // Environment validation
  const requiredEnvVars = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PESAPAL_CONSUMER_KEY",
    "PESAPAL_CONSUMER_SECRET",
    "PESAPAL_API_URL",
    "APP_URL",
    "VAT_PERCENTAGE",
  ] as const;

  for (const envVar of requiredEnvVars) {
    if (!Deno.env.get(envVar)) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  // Initialize Supabase client
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: menuItems, error: menuError } = await supabaseClient
    .from("menus")
    .select("id, price, name")
    .in(
      "id",
      order_items.map((item) => item.id)
    );

  if (menuError || !menuItems) {
    throw new Error("Failed to fetch menu items");
  }

  const addonIds = order_items
    .flatMap((item) => item.selectedAddons || [])
    .filter((addon) => addon && addon.id && addon.id.trim() !== "") // Filter out null/empty IDs
    .map((addon) => addon.id);

  console.log("Requested addon IDs:", addonIds);

  // Create a map for storing addon prices
  let addonPricesMap = new Map<string, Addon>();

  // Only fetch addons if we have valid IDs
  if (addonIds.length > 0) {
    const { data: addons, error: addonsError } = await supabaseClient
      .from("addons")
      .select("id, name, price")
      .in("id", addonIds)
      .eq("is_available", true);

    if (addonsError) {
      console.error("Database error when fetching addons:", addonsError);
      throw new Error(`Failed to fetch addon prices: ${addonsError.message}`);
    }

    if (!addons) {
      throw new Error("Failed to fetch addons from database");
    }
    console.log("Found addons in database:", addons);

    if (!addons || addons.length === 0) {
      throw new Error("No addons found in the database");
    }

    // Find which valid addons are missing
    const foundAddonIds = new Set(addons.map((a) => a.id));
    const missingAddonIds = addonIds.filter((id) => !foundAddonIds.has(id));

    if (missingAddonIds.length > 0) {
      throw new Error(
        `Some addons were not found or are not available. Missing addon IDs: ${missingAddonIds.join(
          ", "
        )}`
      );
    }

    addonPricesMap = new Map(addons.map((addon) => [addon.id, addon]));
  }

  // console.log("selected Option Details: " , item.selectedOptionDetails);
  // Get all valid option IDs from order items
  // Create a map for storing option details
  let menuOptionsMap = new Map<string, MenuOption>();

  const optionIds = order_items
    .flatMap((item) => item.selectedOptionDetails || [])
    .filter((option) => option && option.id && option.id.trim() !== "")
    .map((option) => option.id);

  console.log("Creating menu options map:", optionIds);
  // Fetch menu options if we have valid IDs
  if (optionIds.length > 0) {
    const { data: menuOptions, error: optionsError } = await supabaseClient
      .from("menu_options")
      .select("id, name, price_adjustment")
      .in("id", optionIds);

    console.log("Fetched menu options from database:", menuOptions);

    if (optionsError) {
      console.error("Database error when fetching menu options:", optionsError);
      throw new Error(`Failed to fetch menu options: ${optionsError.message}`);
    }

    if (!menuOptions) {
      throw new Error("Failed to fetch menu options from database");
    }

    // Find which valid options are missing
    const foundOptionIds = new Set(menuOptions.map((o) => o.id));
    const missingOptionIds = optionIds.filter((id) => !foundOptionIds.has(id));

    if (missingOptionIds.length > 0) {
      throw new Error(
        `Some menu options were not found or are not active. Missing option IDs: ${missingOptionIds.join(
          ", "
        )}`
      );
    }

    menuOptionsMap = new Map(menuOptions.map((option) => [option.id, option]));
  }

  // Create a map for quick price lookups
  const menuItemsMap = new Map(menuItems.map((item) => [item.id, item]));

  // Recalculate order items with actual prices
  const recalculatedItems = order_items.map((item) => {
    const menuItem = menuItemsMap.get(item.id);
    if (!menuItem) {
      throw new Error(`Menu item with id ${item.id} not found`);
    }

    // Calculate addon total with actual prices, skipping invalid addons
    // Calculate addon total (existing code)
    const addon_total = (item.selectedAddons || [])
      .filter((addon) => addon && addon.id && addon.id.trim() !== "")
      .reduce((total, addon) => {
        const addonData = addonPricesMap.get(addon.id);
        if (!addonData) return total;
        return total + addonData.price;
      }, 0);

    // Calculate options price adjustment
    const options_total = (item.selectedOptionDetails || [])
      .filter((option) => option && option.id && option.id.trim() !== "")
      .reduce((total, option) => {
        const optionData = menuOptionsMap.get(option.id);
        if (!optionData) return total;
        return total + (optionData.price_adjustment || 0);
      }, 0);

    const base_price = menuItem.price;
    const price = base_price + addon_total + options_total;
    const subtotal = price * item.quantity;

    return {
      ...item,
      name: menuItem.name,
      base_price,
      price,
      addon_total,
      options_total,
      subtotal,
      verified_addons: (item.selectedAddons || [])
        .filter((addon) => addon && addon.id && addon.id.trim() !== "")
        .map((addon) => {
          const addonData = addonPricesMap.get(addon.id);
          if (!addonData) return null;
          return {
            addon_id: addon.id,
            quantity: 1,
            price: addonData.price,
            name: addonData.name,
          };
        })
        .filter(Boolean),
      verified_options: (item.selectedOptionDetails || [])
        .filter((option) => option && option.id && option.id.trim() !== "")
        .map((option) => {
          const optionData = menuOptionsMap.get(option.id);
          if (!optionData) return null;
          return {
            menu_option_id: option.id,
            option_name: optionData.name,
            quantity: 1,
            price_adjustment: optionData.price_adjustment || 0,
            selected_value: option.value,
          };
        })
        .filter(Boolean),
    };
  });

  // Calculate totals
  const total_amount = recalculatedItems.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );
  const vat = total_amount * 0.18;
  const total_amount_vat = total_amount + vat;

  // Payment processing based on payment method
  let pesapalResponse = null;
  let initialOrderStatus = status;

  if (payment_method.toLowerCase() === "cash") {
    // For cash payments, no Pesapal integration needed
    // Order status remains as provided (usually "pending")
    console.log("Processing cash payment - no payment gateway required");
  } else if (payment_method.toLowerCase() === "online") {
    // For online payments, integrate with Pesapal
    const token = await generatePesapalToken();
    pesapalResponse = await createPesapalOrder(
      crypto.randomUUID(),
      total_amount_vat,
      phone_number,
      token
    );
    // For online payments, set status to "Awaiting Payment"
    initialOrderStatus = "Awaiting Payment";
  } else {
    throw new Error(`Unsupported payment method: ${payment_method}`);
  }

  // Helper functions
  async function generatePesapalToken(): Promise<string> {
    try {
      const response = await fetch(
        `${Deno.env.get("PESAPAL_API_URL")}/api/Auth/RequestToken`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            consumer_key: Deno.env.get("PESAPAL_CONSUMER_KEY"),
            consumer_secret: Deno.env.get("PESAPAL_CONSUMER_SECRET"),
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Pesapal token generation failed: ${JSON.stringify(errorData)}`
        );
      }

      const data = await response.json();
      return data.token;
    } catch (error) {
      console.error("Error generating Pesapal token:", error);
      throw new Error("Failed to generate Pesapal authentication token");
    }
  }

  async function createPesapalOrder(
    orderId: string,
    amount: number,
    phoneNumber: string,
    token: string
  ): Promise<PesapalOrderResponse> {
    try {
      const response = await fetch(
        `https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: orderId,
            currency: "UGX",
            amount: amount,
            description: "Payment for food delivery",
            callback_url:
              "https://mlpgrevfohpiaepnnsch.supabase.co/functions/v1/pesapal_callback",
            notification_id: "8ce514fb-48d3-47ef-9dd9-dc1dfc6aaf9b",
            branch: "UMESKIA SOFTWARES",
            billing_address: {
              email_address: "simonogm2000@gmail.com",
              phone_number: phoneNumber,
              country_code: "UG",
              first_name: "Simon",
              middle_name: "OG",
              last_name: "Kiveu",
              line_1: "Pesapal Limited",
              line_2: "",
              city: "",
              state: "",
              postal_code: "",
              zip_code: "",
            },
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Pesapal order creation failed: ${JSON.stringify(errorData)}`
        );
      }
      console.log(response);

      const data = await response.json();
      console.log("Pesapal Order Response:", data);

      return data;
    } catch (error) {
      console.error("Error creating Pesapal order:", error);
      throw new Error("Failed to create payment order with Pesapal");
    }
  }

  const { data: order, error: orderError } = await supabaseClient
    .from("orders")
    .insert({
      order_items: recalculatedItems,
      total_amount,
      delivery_address,
      phone_number,
      delivery_method,
      payment_status: initialOrderStatus,
      status: initialOrderStatus,
      delivery_person_id,
      user_id,
      payment_method,
      total_amount_vat,
      vat,
      order_note,
      delivery_location,
      delivery_latitude,
      delivery_longitude,
      delivery_location2: deliveryLocationGeog,
      tracking_id: pesapalResponse?.order_tracking_id || null,
      hi: "hello",
    })
    .select()
    .single();

  if (orderError) {
    throw new Error(`Failed to create order: ${orderError.message}`);
  }

  if (order) {
    await createNotification(
      supabaseClient,
      user_id,
      order.id,
      "Order Placed Successfully!",
      `Your payment for order #${order.id} will be collected on delivery.`,
      "ORDER PLACED"
    );
  }
  // Prepare order items for insertion with recalculated prices
  const orderItemsToInsert = recalculatedItems.map((item) => ({
    order_id: order.id,
    menu_item_id: item.id,
    item_name: item.name,
    base_price: item.base_price,
    quantity: item.quantity,
    subtotal: item.subtotal,
    addon_total: item.addon_total,
    total_item_price: item.price,
    choices_price_total: item.choices_price_total || 0,
    vat: item.subtotal * 0.18,
    special_instructions: item.special_instructions || null,
    cooking_preferences: null,
    is_gluten_free: item.is_gluten_free || false,
    is_vegetarian: item.is_vegetarian || false,
    is_vegan: item.is_vegan || false,
    requires_special_preparation: item.requires_special_preparation || false,
  }));

  // Insert order items and get their IDs
  const { data: insertedOrderItems, error: itemsError } = await supabaseClient
    .from("order_items")
    .insert(orderItemsToInsert)
    .select("id, menu_item_id");

  if (itemsError || !insertedOrderItems) {
    // If order items insertion fails, attempt to delete the order
    await supabaseClient.from("orders").delete().match({ id: order.id });

    throw new Error(`Failed to create order items: ${itemsError?.message}`);
  }

  // Create a map of menu_item_id to order_item_id
  const orderItemIdMap = new Map(
    insertedOrderItems.map((item) => [item.menu_item_id, item.id])
  );

  // Prepare addon items for insertion
  // Update the order item addons insertion to only use valid addons
  const orderItemAddonsToInsert = recalculatedItems.flatMap((item) => {
    const orderItemId = orderItemIdMap.get(item.id);
    return (item.verified_addons || [])
      .filter((addon) => addon !== null) // Make sure we only use valid addons
      .map((addon) => ({
        order_item_id: orderItemId,
        addon_id: addon.addon_id,
        quantity: 1,
        addon_price: addon.price,
      }));
  });

  // Insert order item addons if there are any
  if (orderItemAddonsToInsert.length > 0) {
    const { error: addonsError } = await supabaseClient
      .from("order_item_addons")
      .insert(orderItemAddonsToInsert);

    if (addonsError) {
      // If addon insertion fails, attempt to delete the order and order items
      await supabaseClient.from("orders").delete().match({ id: order.id });

      throw new Error(
        `Failed to create order item addons: ${addonsError.message}`
      );
    }
  }

  // After creating order items and getting their IDs
  // Insert order item options
  const orderItemOptionsToInsert = recalculatedItems.flatMap((item) => {
    const orderItemId = orderItemIdMap.get(item.id);
    return (item.verified_options || [])
      .filter((option) => option !== null)
      .map((option) => ({
        order_item_id: orderItemId,
        menu_option_id: option.menu_option_id,
        quantity: 1,
        option_price_adjustment: option.price_adjustment,
        option_name: option.option_name,
      }));
  });

  // Insert options if we have any
  if (orderItemOptionsToInsert.length > 0) {
    const { error: optionsError } = await supabaseClient
      .from("order_item_options")
      .insert(orderItemOptionsToInsert);

    if (optionsError) {
      // If options insertion fails, attempt to delete the order and order items
      await supabaseClient.from("orders").delete().match({ id: order.id });

      throw new Error(
        `Failed to create order item options: ${optionsError.message}`
      );
    }
  }

  return {
    order,
    payment:
      payment_method.toLowerCase() === "online"
        ? {
            paymentUrl: pesapalResponse.redirect_url,
            tracking_id: pesapalResponse.order_tracking_id,
          }
        : {
            status: "cash_payment",
            message:
              "Order placed successfully. Payment will be collected on delivery.",
          },
  };
}

// Main handler
serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      throw new Error("Method not allowed");
    }

    const orderRequest: OrderRequest = await req.json();

    // Validate required fields
    if (
      !orderRequest.order_items?.length ||
      !orderRequest.delivery_address ||
      !orderRequest.phone_number ||
      !orderRequest.user_id
    ) {
      throw new Error("Missing required fields");
    }

    // Create order and order items
    const result = await createOrderWithItems(orderRequest);

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        data: result,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error("Error processing order:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Internal server error",
      }),
      {
        status: error.status || 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
});
