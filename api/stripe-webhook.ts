import { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";

// Initialize Stripe and Supabase clients
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

const supabase = createClient<Database>(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// Safely coerce arbitrary values into the project's Json type
const toSafeJson = (value: unknown): Database["public"]["Tables"]["payment_events"]["Row"]["payload"] => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => toSafeJson(v));
  }
  if (typeof value === "object") {
    const plain: { [key: string]: ReturnType<typeof toSafeJson> | undefined } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip undefined to match Json type definition
      const coerced = toSafeJson(v);
      plain[k] = coerced as Database["public"]["Tables"]["payment_events"]["Row"]["payload"];
    }
    return plain;
  }
  // Fallback for unsupported types (e.g., bigint, function, symbol)
  return String(value);
};

// Endpoint to handle Stripe webhooks
export default async (req: VercelRequest, res: VercelResponse) => {
  const sig = req.headers["stripe-signature"] as string;

  let event: Stripe.Event;

  try {
    console.log("[webhook] stripe signature header present:", Boolean(sig));
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Webhook signature verification failed: ${message}`);
    return res.status(400).send(`Webhook Error: ${message}`);
  }
  console.log("[webhook] received event type:", event.type);

  const insertPaymentEvent = async (
    stripeEvent: Stripe.Event,
    paymentId?: string
  ): Promise<void> => {
    const payload = toSafeJson(stripeEvent.data?.object ?? null);
    const { error: evtErr } = await supabase.from("payment_events").insert({
      stripe_event_id: stripeEvent.id,
      stripe_event_type: stripeEvent.type,
      payload,
      payment_id: paymentId ?? null,
    });
    if (evtErr) {
      console.error("Failed to insert payment_event:", evtErr);
    }
  };

  const mapPiStatusToPaymentStatus = (piStatus: Stripe.PaymentIntent.Status): Database["public"]["Enums"]["payment_status"] => {
    switch (piStatus) {
      case "requires_payment_method":
        return "requires_payment_method";
      case "requires_action":
        return "requires_action";
      case "processing":
        return "processing";
      case "succeeded":
        return "succeeded";
      case "canceled":
        return "canceled";
      case "requires_capture":
        // Not in enum; treat as requires_action
        return "requires_action";
      default:
        return "created";
    }
  };

  const upsertPaymentFromSession = async (
    session: Stripe.Checkout.Session
  ): Promise<string | undefined> => {
    try {
      const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (!piId) {
        console.warn("Missing payment_intent id on session", session.id);
        return undefined;
      }

      // Fetch PaymentIntent for richer data
      const pi = await stripe.paymentIntents.retrieve(piId);

      // Attempt to find existing payment row by PI id
      const { data: existing, error: findErr } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_payment_intent_id", pi.id)
        .limit(1)
        .maybeSingle();
      if (findErr) {
        console.error("Failed to query payments:", findErr);
      }
      if (existing?.id) {
        console.log("[payments] existing payment found for PI", pi.id, existing.id);
        return existing.id;
      }

      // Derive optional amounts and receipt
      const amount_total = typeof session.amount_total === "number" ? session.amount_total : 0;
      const amount_subtotal = typeof session.amount_subtotal === "number" ? session.amount_subtotal : null;
      const totalDetails = session.total_details;
      const amount_tax = totalDetails?.amount_tax ?? null;
      const amount_discount = totalDetails?.amount_discount ?? null;
      const amount_shipping = totalDetails?.amount_shipping ?? null;

      const latestChargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : undefined;
      let receipt_url: string | null = null;
      if (latestChargeId) {
        try {
          const charge = await stripe.charges.retrieve(latestChargeId);
          receipt_url = charge.receipt_url ?? null;
        } catch (e: unknown) {
          console.warn("Unable to retrieve charge receipt_url", e);
        }
      }

      const cust = session.customer_details;
      const address = cust?.address ? JSON.stringify(cust.address) : null;
      const metadata = session.metadata ? (session.metadata as unknown as Database["public"]["Tables"]["payments"]["Row"]["metadata"]) : {};
      const userIdFromMetadata = typeof session.metadata?.user_id === "string" ? session.metadata.user_id : null;

      const status = mapPiStatusToPaymentStatus(pi.status);

      const { data: inserted, error: insertErr } = await supabase
        .from("payments")
        .insert({
          amount_total,
          amount_subtotal,
          amount_tax: amount_tax ?? null,
          amount_discount: amount_discount ?? null,
          amount_shipping: amount_shipping ?? null,
          attempt_count: 0,
          currency: String(session.currency ?? pi.currency ?? "myr"),
          livemode: Boolean(event.livemode),
          email: cust?.email ?? null,
          name: cust?.name ?? null,
          phone: cust?.phone ?? null,
          provider: "stripe",
          receipt_url,
          refund_status: "not_refunded",
          refunded_amount: 0,
          shipping_address: address,
          status,
          stripe_checkout_session_id: session.id,
          stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
          stripe_payment_intent_id: pi.id,
          updated_at: new Date().toISOString(),
          user_id: userIdFromMetadata,
          metadata: toSafeJson(session.metadata ?? {}),
          payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
          payment_method_type: Array.isArray(pi.payment_method_types) && pi.payment_method_types.length > 0 ? pi.payment_method_types[0] : null,
          latest_charge_id: latestChargeId ?? null,
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error("Failed to insert payment:", insertErr);
        return undefined;
      }
      console.log("[payments] inserted payment id:", inserted?.id);
      return inserted?.id;
    } catch (e: unknown) {
      console.error("Error upserting payment from session:", e);
      return undefined;
    }
  };

  const upsertPaymentFromPaymentIntent = async (
    pi: Stripe.PaymentIntent
  ): Promise<string | undefined> => {
    try {
      const { data: existing, error: findErr } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_payment_intent_id", pi.id)
        .limit(1)
        .maybeSingle();
      if (findErr) {
        console.error("Failed to query payments (PI):", findErr);
      }
      if (existing?.id) {
        console.log("[payments] existing payment found (PI)", pi.id, existing.id);
        return existing.id;
      }

      const latestChargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : undefined;
      let receipt_url: string | null = null;
      if (latestChargeId) {
        try {
          const charge = await stripe.charges.retrieve(latestChargeId);
          receipt_url = charge.receipt_url ?? null;
        } catch (e: unknown) {
          console.warn("Unable to retrieve charge receipt_url (PI)", e);
        }
      }

      const status = mapPiStatusToPaymentStatus(pi.status);

      const { data: inserted, error: insertErr } = await supabase
        .from("payments")
        .insert({
          amount_total: typeof pi.amount_received === "number" && pi.amount_received > 0 ? pi.amount_received : pi.amount,
          amount_subtotal: null,
          amount_tax: null,
          amount_discount: null,
          amount_shipping: null,
          attempt_count: 0,
          currency: String(pi.currency ?? "myr"),
          livemode: Boolean(event.livemode),
          email: null,
          name: null,
          phone: null,
          provider: "stripe",
          receipt_url,
          refund_status: "not_refunded",
          refunded_amount: 0,
          shipping_address: null,
          status,
          stripe_checkout_session_id: null,
          stripe_customer_id: typeof pi.customer === "string" ? pi.customer : null,
          stripe_payment_intent_id: pi.id,
          updated_at: new Date().toISOString(),
          user_id: null,
          metadata: toSafeJson(pi.metadata ?? {}),
          payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : null,
          payment_method_type: Array.isArray(pi.payment_method_types) && pi.payment_method_types.length > 0 ? pi.payment_method_types[0] : null,
          latest_charge_id: latestChargeId ?? null,
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error("Failed to insert payment (PI):", insertErr);
        return undefined;
      }
      console.log("[payments] inserted payment from PI id:", inserted?.id);
      return inserted?.id;
    } catch (e: unknown) {
      console.error("Error upserting payment from PaymentIntent:", e);
      return undefined;
    }
  };

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      let paymentId: string | undefined;
      if (session.payment_status === "paid" && session.id) {
        paymentId = await upsertPaymentFromSession(session);
      }
      await insertPaymentEvent(event, paymentId);
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      // Update existing payment status if present
      const { data: existing } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_payment_intent_id", pi.id)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        await supabase
          .from("payments")
          .update({
            status: "failed",
            error_type: pi.last_payment_error?.type ?? null,
            failure_code: pi.last_payment_error?.code ?? null,
            failure_message: pi.last_payment_error?.message ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      }
      await insertPaymentEvent(event, existing?.id);
      break;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      // Ensure payment row exists (create from PI if missing), then mark succeeded
      const { data: existing } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_payment_intent_id", pi.id)
        .limit(1)
        .maybeSingle();
      let paymentId = existing?.id;
      if (!paymentId) {
        paymentId = await upsertPaymentFromPaymentIntent(pi);
      }
      if (paymentId) {
        await supabase
          .from("payments")
          .update({ status: "succeeded", updated_at: new Date().toISOString() })
          .eq("id", paymentId);
      }
      await insertPaymentEvent(event, paymentId);
      break;
    }
    default: {
      await insertPaymentEvent(event);
      break;
    }
  }

  res.status(200).json({ received: true });
};
