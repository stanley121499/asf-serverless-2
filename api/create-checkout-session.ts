import { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Initialize Stripe and Supabase clients
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

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
    const { items, customerId } = req.body;

    if (!items || items.length === 0 || !customerId) {
      return res
        .status(400)
        .json({ error: "Items and customer ID are required." });
    }

    // Create line items for the checkout session
    const lineItems = items.map(
      (item: { name: string; price: number; quantity: number }) => ({
        price_data: {
          currency: "myr",
          product_data: {
            name: item.name,
          },
          unit_amount: item.price, // Stripe expects the amount in cents
        },
        quantity: item.quantity,
      })
    );

    // Create a Checkout Session for multiple items with shipping and phone number collection
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${process.env.CLIENT_URL}/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/order-cancel`,
      shipping_address_collection: {
        allowed_countries: ["MY", "US", "CA"], // Specify the countries allowed for shipping
      },
      phone_number_collection: {
        enabled: true,
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
