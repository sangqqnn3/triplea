// triplea-proxy.js
import express from 'express';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config(); // Đọc biến môi trường từ file .env

const app = express();
app.use(cors());
app.use(bodyParser.json());

const CLIENT_ID = process.env.TRIPLEA_CLIENT_ID;
const CLIENT_SECRET = process.env.TRIPLEA_CLIENT_SECRET;
const MERCHANT_KEY = process.env.TRIPLEA_MERCHANT_KEY; // API ID từ dashboard

let accessToken = '';
let tokenExpiry = 0;

// Triple-A API Authentication
// Theo docs: https://developers.triple-a.io/docs/triplea-api-doc/441bcc097e756-authentication-and-credentials
// Triple-A có thể dùng OAuth hoặc API key authentication
// Nếu OAuth fail, dùng CLIENT_SECRET trực tiếp làm API key

async function getAccessToken() {
  if (accessToken && tokenExpiry > Date.now()) return accessToken;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing TRIPLEA_CLIENT_ID or TRIPLEA_CLIENT_SECRET');
  }

  // Thử OAuth endpoint (có thể không hỗ trợ, sẽ fallback)
  const tokenUrl = 'https://api.triple-a.io/v3/oauth/token';
  
  try {
    console.log('Requesting Triple-A OAuth token...');
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        audience: 'https://api.triple-a.io/v3/',
        grant_type: 'client_credentials'
      })
    });
    
    const data = await res.json();
    
    if (res.ok && data.access_token) {
      accessToken = data.access_token;
      tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
      console.log('✅ OAuth token obtained');
      return accessToken;
    }
    
    // OAuth không hỗ trợ → dùng CLIENT_SECRET trực tiếp
    console.log('⚠️ OAuth not supported, using CLIENT_SECRET as API key');
    accessToken = CLIENT_SECRET;
    tokenExpiry = Date.now() + (3600 * 1000);
    return accessToken;
    
  } catch (error) {
    // OAuth error → dùng CLIENT_SECRET trực tiếp
    console.log('⚠️ OAuth error, using CLIENT_SECRET as API key:', error.message);
    accessToken = CLIENT_SECRET;
    tokenExpiry = Date.now() + (3600 * 1000);
    return accessToken;
  }
}

// Tạo payment/invoice Triple-A
// Theo docs: https://developers.triple-a.io/docs/triplea-api-doc
app.post('/api/triplea/payment', async (req, res) => {
  try {
    const { order_id, amount, currency, description, success_url, cancel_url, callback_url } = req.body;
    
    console.log('📦 Creating Triple-A payment:', { order_id, amount, currency });
    
    if (!order_id || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: order_id, amount' 
      });
    }
    
    const token = await getAccessToken();
    const merchantKey = req.body.merchant_key || MERCHANT_KEY;
    
    if (!merchantKey) {
      return res.status(400).json({ 
        error: 'Missing merchant_key (TRIPLEA_MERCHANT_KEY)' 
      });
    }
    
    // Format payment payload theo Triple-A API
    const paymentPayload = {
      merchant_key: merchantKey,
      order_id: String(order_id),
      amount: Number(amount).toFixed(2),
      currency: currency || 'USD',
      description: description || 'Shop Payment',
      success_url: success_url || req.body.success_url || 'https://yourdomain.com/',
      fail_url: cancel_url || req.body.cancel_url || 'https://yourdomain.com/payout.html',
      callback_url: callback_url || req.body.callback_url || `${req.protocol}://${req.get('host')}/api/triplea/webhook`
    };
    
    console.log('📤 Sending to Triple-A API:', { 
      ...paymentPayload, 
      merchant_key: merchantKey.substring(0, 8) + '...' 
    });
    
    // Authentication: thử nhiều cách
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    
    // Triple-A có thể dùng Bearer token hoặc API key
    if (token.startsWith('ey')) {
      // JWT token từ OAuth
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      // API key authentication (thử nhiều format)
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-API-Key'] = token;
      // Hoặc merchant key authentication
      if (merchantKey) {
        headers['X-Merchant-Key'] = merchantKey;
      }
    }
    
    console.log('🔐 Auth method:', token.startsWith('ey') ? 'OAuth Bearer' : 'API Key');
    
    // Gọi Triple-A API
    const paymentRes = await fetch('https://api.triple-a.io/v3/payments', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(paymentPayload)
    });
    
    const responseText = await paymentRes.text();
    let data;
    
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('⚠️ Response is not JSON:', responseText);
      return res.status(paymentRes.status).json({ 
        error: 'Invalid response from Triple-A API',
        response: responseText.substring(0, 200)
      });
    }
    
    if (!paymentRes.ok) {
      console.error('❌ Triple-A API error:', {
        status: paymentRes.status,
        statusText: paymentRes.statusText,
        error: data
      });
      
      // Xử lý error codes theo docs
      return res.status(paymentRes.status).json({
        error: data.error || data.message || 'Triple-A API error',
        code: data.code,
        details: data
      });
    }
    
    console.log('✅ Payment created:', {
      order_id: data.order_id || data.payment_id,
      payment_url: data.payment_url || data.redirect_url || data.hosted_url
    });
    
    res.status(200).json({
      success: true,
      order_id: data.order_id || data.payment_id,
      payment_url: data.payment_url || data.redirect_url || data.hosted_url,
      payment_id: data.payment_id || data.id,
      ...data
    });
    
  } catch (error) {
    console.error('❌ Payment endpoint error:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Webhook nhận trạng thái thanh toán (Triple-A gọi về)
// Theo docs: https://developers.triple-a.io/docs/triplea-api-doc/0c40f1b88af6a-payment-statuses
// Đảm bảo URL này public và thiết lập tại dashboard Triple-A
app.post('/api/triplea/webhook', (req, res) => {
  try {
    const { order_id, payment_id, status, amount, currency, timestamp } = req.body;
    
    console.log('📬 Triple-A Webhook received:', {
      order_id,
      payment_id,
      status,
      amount,
      currency,
      timestamp
    });
    
    // Payment statuses theo docs:
    // - pending: Đang chờ thanh toán
    // - processing: Đang xử lý
    // - completed: Hoàn thành
    // - failed: Thất bại
    // - cancelled: Đã hủy
    // - refunded: Đã hoàn tiền
    
    // TODO:
    // 1. Xác thực webhook signature (nếu Triple-A hỗ trợ)
    // 2. Lưu/update order status vào database
    // 3. Gửi email notification nếu cần
    
    if (status === 'completed' || status === 'success') {
      console.log('✅ Payment completed for order:', order_id);
      // Update order status to "paid" trong database
    } else if (status === 'failed' || status === 'cancelled') {
      console.log('❌ Payment failed/cancelled for order:', order_id);
      // Update order status to "failed" trong database
    }
    
    // Luôn trả 200 để Triple-A biết đã nhận được
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    // Vẫn trả 200 để Triple-A không retry
    res.sendStatus(200);
  }
});

// Route test authentication
app.get('/api/triplea/test-auth', async (req, res) => {
  try {
    console.log('🔐 Testing Triple-A authentication...');
    
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(400).json({
        status: 'error',
        error: 'Missing credentials',
        has_client_id: !!CLIENT_ID,
        has_client_secret: !!CLIENT_SECRET,
        has_merchant_key: !!MERCHANT_KEY
      });
    }
    
    const token = await getAccessToken();
    const authMethod = token.startsWith('ey') ? 'OAuth Bearer Token' : 'API Key (CLIENT_SECRET)';
    
    res.json({
      status: 'ok',
      auth_method: authMethod,
      token_preview: token.substring(0, 15) + '...',
      token_length: token.length,
      has_merchant_key: !!MERCHANT_KEY,
      note: authMethod.includes('API Key') 
        ? 'Using CLIENT_SECRET directly as API key (OAuth may not be supported)' 
        : 'Using OAuth token successfully'
    });
  } catch (error) {
    console.error('❌ Test auth error:', error);
    res.status(500).json({
      status: 'error',
      error: String(error),
      message: 'Authentication failed. Check CLIENT_ID and CLIENT_SECRET in environment variables.'
    });
  }
});

// Route test server
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Triple-A Proxy',
    endpoints: {
      payment: 'POST /api/triplea/payment',
      webhook: 'POST /api/triplea/webhook',
      test_auth: 'GET /api/triplea/test-auth',
      health: 'GET /healthz'
    },
    env_check: {
      has_client_id: !!CLIENT_ID,
      has_client_secret: !!CLIENT_SECRET,
      has_merchant_key: !!MERCHANT_KEY
    },
    note: 'If OAuth fails, proxy will fallback to API key authentication. Check logs for details.'
  });
});

// Healthcheck simple
app.get('/healthz', (req, res) => res.send('ok'));

// Render/Railway sẽ đặt PORT qua biến môi trường
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Triple-A proxy backend up on port', PORT);
  console.log('Environment check:', {
    has_client_id: !!CLIENT_ID,
    has_client_secret: !!CLIENT_SECRET,
    has_merchant_key: !!MERCHANT_KEY
  });
});
