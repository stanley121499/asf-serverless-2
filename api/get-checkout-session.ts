import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

// Initialize Stripe with secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

/**
 * Retrieve a Stripe Checkout Session by id with useful expansions for UI rendering.
 */
export default async (req: VercelRequest, res: VercelResponse) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow requests from any origin
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const sessionId = req.query.session_id as string;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Retrieve the session details from Stripe with expansions
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: [
        'payment_intent',
        'customer',
        'line_items',
        'line_items.data.price.product',
      ],
    });

    return res.status(200).json(session);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error retrieving checkout session:', message);
    return res.status(500).json({ error: message });
  }
};
