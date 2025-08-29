import { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";

/**
 * Initialize Stripe and Supabase clients.
 * Stripe is used to create checkout sessions.
 * Supabase is currently unused here but kept for future order pre-creation if needed.
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

const supabase = createClient<Database>(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

/**
 * Create a Stripe Checkout Session for the provided cart items and user.
 * Adds metadata (user_id) so the webhook can link payments to users.
 */
export default async (req: VercelRequest, res: VercelResponse) => {
  // Add CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow requests from any origin
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  try {
    // Extract product and customer details from the request body
    const { items, customerId, successUrl, cancelUrl } = req.body as {
      items: Array<{ name: string; price: number; quantity: number }>;
      customerId: string;
      successUrl?: string;
      cancelUrl?: string;
    };

    if (!Array.isArray(items) || items.length === 0 || typeof customerId !== "string" || customerId.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "Items and customer ID are required." });
    }

    // Create line items for the checkout session
    // Normalize items and validate fields
    const lineItems = items.map((item) => ({
      price_data: {
        currency: "myr",
        product_data: {
          name: String(item.name ?? "Item"),
        },
        // Stripe expects the amount in the smallest currency unit
        unit_amount: Number(item.price),
      },
      quantity: Number(item.quantity),
    }));

    // Resolve URLs: prefer client-provided, fallback to env-based defaults
    const baseClientUrl = (process.env.CLIENT_URL as string | undefined) ?? "";
    const resolvedSuccessUrl = typeof successUrl === "string" && successUrl.trim().length > 0
      ? successUrl
      : `${baseClientUrl.replace(/\/$/, "")}/order-success?session_id={CHECKOUT_SESSION_ID}`;
    const resolvedCancelUrl = typeof cancelUrl === "string" && cancelUrl.trim().length > 0
      ? cancelUrl
      : `${baseClientUrl.replace(/\/$/, "")}/order-cancel`;

    // Create a Checkout Session for multiple items with shipping and phone number collection
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: resolvedSuccessUrl,
      cancel_url: resolvedCancelUrl,
      shipping_address_collection: {
        // Specify the countries allowed for shipping
        allowed_countries: ["MY", "US", "CA"],
      },
      phone_number_collection: {
        enabled: true,
      },
      // Attach metadata so the webhook can link payments to the Supabase user
      metadata: {
        user_id: customerId,
      },
    });

    // // Optional: Store order details in Supabase
    // const { data, error } = await supabase
    //   .from('orders')
    //   .insert([{ customer_id: customerId, stripe_session_id: session.id, status: 'pending' }])
    //   .select('*')
    //   .single();

    // if (error) {
    //   throw error;
    // }

    // Return the session ID to the client
    return res.status(200).json({ id: session.id });
  } catch (error: any) {
    console.error("Error creating checkout session:", error);
    return res.status(500).json({ error: error.message });
  }
};
