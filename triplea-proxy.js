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

// Hàm lấy access token Triple-A (có cache ngắn hạn)
async function getAccessToken() {
  if (accessToken && tokenExpiry > Date.now()) return accessToken;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing TRIPLEA_CLIENT_ID or TRIPLEA_CLIENT_SECRET in environment variables');
  }

  // Triple-A OAuth endpoint chính thức
  const tokenUrl = 'https://api.triple-a.io/v3/oauth/token';
  
  try {
    console.log('Requesting Triple-A access token...');
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
    
    if (!res.ok) {
      console.error('Triple-A token error:', data);
      throw new Error(`Token request failed: ${res.status} - ${JSON.stringify(data)}`);
    }
    
    if (!data.access_token) {
      throw new Error('No access_token in response: ' + JSON.stringify(data));
    }
    
    accessToken = data.access_token;
    tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
    console.log('Triple-A access token obtained successfully');
    return accessToken;
  } catch (error) {
    console.error('Triple-A token fetch error:', error);
    throw new Error('Cannot get Triple-A token: ' + String(error));
  }
}

// Tạo payment/invoice Triple-A
app.post('/api/triplea/payment', async (req, res) => {
  try {
    console.log('Received payment request:', {
      order_id: req.body.order_id,
      amount: req.body.amount,
      currency: req.body.currency
    });
    
    const token = await getAccessToken();
    console.log('Access token obtained, creating payment...');
    
    const paymentPayload = {
      merchant_key: req.body.merchant_key || MERCHANT_KEY,
      order_id: req.body.order_id,
      amount: Number(req.body.amount),
      currency: req.body.currency || 'USD',
      description: req.body.description || 'Shop Payment',
      success_url: req.body.success_url || 'https://yourdomain.com/',
      fail_url: req.body.cancel_url || 'https://yourdomain.com/payout.html',
      callback_url: req.body.callback_url || 'https://yourdomain.com/api/triplea/webhook'
    };
    
    console.log('Sending payment request to Triple-A:', paymentPayload);
    
    const paymentRes = await fetch('https://api.triple-a.io/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(paymentPayload)
    });
    
    const data = await paymentRes.json();
    
    if (!paymentRes.ok) {
      console.error('Triple-A payment API error:', {
        status: paymentRes.status,
        response: data
      });
      return res.status(paymentRes.status).json(data);
    }
    
    console.log('Payment created successfully:', {
      order_id: data.order_id,
      payment_url: data.payment_url || data.redirect_url
    });
    
    res.status(200).json(data);
  } catch (error) {
    console.error('Payment endpoint error:', error);
    res.status(500).json({ 
      error: 'Backend Triple-A proxy error', 
      detail: String(error),
      message: error.message 
    });
  }
});

// Webhook nhận trạng thái thanh toán (Triple-A gọi về)
// Đảm bảo URL này public và thiết lập tại dashboard Triple-A
app.post('/api/triplea/webhook', (req, res) => {
  // Nhận thông tin và lưu log/DB
  console.log('Triple-A Webhook:', req.body);
  // TODO: xác thực signature, cập nhật trạng thái order theo order_id
  res.sendStatus(200);
});

// Route test server
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Triple-A Proxy',
    endpoints: {
      payment: 'POST /api/triplea/payment',
      webhook: 'POST /api/triplea/webhook',
      health: 'GET /healthz'
    },
    env_check: {
      has_client_id: !!CLIENT_ID,
      has_client_secret: !!CLIENT_SECRET,
      has_merchant_key: !!MERCHANT_KEY
    }
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
