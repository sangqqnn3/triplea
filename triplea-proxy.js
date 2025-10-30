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

  // Một số tài liệu Triple-A dùng các endpoint token khác nhau theo môi trường.
  // Thử lần lượt để tránh lỗi 405 MethodNotAllowed.
  const tokenUrls = [
    'https://api.triple-a.io/oauth/token',
    'https://api.triple-a.io/v3/oauth/token',
    'https://auth.triple-a.io/oauth/token'
  ];

  let lastErr = null;
  for (const url of tokenUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        return accessToken;
      }
      lastErr = data;
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error('Cannot get Triple-A token: ' + JSON.stringify(lastErr));
}

// Tạo payment/invoice Triple-A
app.post('/api/triplea/payment', async (req, res) => {
  try {
    const token = await getAccessToken();
    // Đọc info order từ body hoặc test cứng tại đây (tùy nhu cầu)
    const paymentRes = await fetch('https://api.triple-a.io/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        merchant_key: req.body.merchant_key || MERCHANT_KEY,
        order_id: req.body.order_id,
        amount: Number(req.body.amount),
        currency: req.body.currency || 'USD',
        description: req.body.description || 'Shop Payment',
        success_url: req.body.success_url || 'https://yourdomain.com/',
        fail_url: req.body.cancel_url || 'https://yourdomain.com/payout.html',
        // Thêm callback_url nếu cần xác nhận tự động (webhook)
        callback_url: req.body.callback_url || 'https://yourdomain.com/api/triplea/webhook'
      })
    });
    const data = await paymentRes.json();
    if (!paymentRes.ok) {
      console.error('Triple-A payment error:', data);
      return res.status(paymentRes.status).json(data);
    }
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Backend Triple-A proxy error', detail: String(error) });
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

// Healthcheck simple
app.get('/healthz', (req, res) => res.send('ok'));

// Render/Railway sẽ đặt PORT qua biến môi trường
app.listen(process.env.PORT || 3000, () => console.log('Triple-A proxy backend up'));
