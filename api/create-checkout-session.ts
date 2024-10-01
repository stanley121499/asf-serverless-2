import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Initialize Stripe and Supabase clients
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async (req: VercelRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    // Extract product and customer details from the request body
    const { name, price, currency = 'usd', customerId } = req.body;

    if (!name || !price || !customerId) {
      return res.status(400).json({ error: 'Product name, price, and customer ID are required.' });
    }

    // Store order details in Supabase (status set to 'pending')
    const { data, error } = await supabase
      .from('orders')
      .insert([{ customer_id: customerId, product_name: name, price, currency, status: 'pending' }])
      .select('*')
      .single()

    if (error) {
      throw error;
    }

    // Create a Product in Stripe
    const product = await stripe.products.create({ name });

    // Create a Price for the product
    const priceData = await stripe.prices.create({
      product: product.id,
      unit_amount: price * 100, // Convert price to cents
      currency,
    });

    // Create a Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceData.id,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/order-cancel`,
    });

    // Update the order with the Stripe session ID
    await supabase
      .from('orders')
      .update({ stripe_session_id: session.id })
      .eq('id', data.id);

    // Return the session ID to the client
    return res.status(200).json({ id: session.id });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({ error: error.message });
  }
};
