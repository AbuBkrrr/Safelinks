const express = require('express');
const router = express.Router();

// Webhook endpoint for Stripe/M-PESA
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'] || req.headers['x-mpesa-signature'];
    const endpointSecret = process.env.PAYMENT_WEBHOOK_SECRET;

    let event;
    try {
        // TODO: Verify the webhook signature with your provider
        event = JSON.parse(req.body);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded' || event.type === 'M_PESA_PAYMENT_SUCCESS') {
        const paymentIntent = event.data.object;
        const voucherId = paymentIntent.metadata.voucher_id;

        // 1. Mark the voucher as paid in your database
        await db.query(
            'UPDATE vouchers SET status = $1, paid_at = NOW() WHERE id = $2',
            ['paid', voucherId]
        );

        // 2. Queue a command for the router polling agent
        await queueRouterCommand(paymentIntent.metadata.router_id, {
            command: 'create_user',
            username: paymentIntent.metadata.username,
            password: paymentIntent.metadata.password,
            profile: paymentIntent.metadata.plan_profile
        });

        console.log(`Payment successful for voucher ${voucherId}.`);
    }

    res.json({received: true});
});

async function queueRouterCommand(routerId, command) {
    // TODO: Insert into your router_commands table
    console.log(`Queued command for router ${routerId}:`, command);
}

module.exports = router;
