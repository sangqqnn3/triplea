// triplea-proxy.js
import express from 'express';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

dotenv.config(); // Đọc biến môi trường từ file .env

const app = express();
app.use(bodyParser.json());

const CLIENT_ID = process.env.TRIPLEA_CLIENT_ID;
const CLIENT_SECRET = process.env.TRIPLEA_CLIENT_SECRET;
const MERCHANT_KEY = process.env.TRIPLEA_MERCHANT_KEY; // API ID từ dashboard

let accessToken = '';
let tokenExpiry = 0;

// Hàm lấy access token Triple-A (có cache ngắn hạn)
async function getAccessToken() {
  if (accessToken && tokenExpiry > Date.now()) return accessToken;
  const res = await fetch('https://api.triple-a.io/v3/oauth/token', {
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
  if (!data.access_token) throw new Error('Cannot get Triple-A token: ' + JSON.stringify(data));
  accessToken = data.access_token;
  tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
  return accessToken;
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
        merchant_key: MERCHANT_KEY,
        order_id: req.body.order_id,
        amount: req.body.amount,
        currency: req.body.currency || 'USD',
        description: req.body.description || 'Shop Payment',
        success_url: req.body.success_url || 'https://sangqqnn3.github.io/',
        fail_url: req.body.cancel_url || 'sangqqnn3.github.io/shopfreestyle/payout.html',
        // Thêm callback_url nếu cần xác nhận tự động (webhook)
        callback_url: req.body.callback_url || 'https://sangqqnn3.github.io/api/triplea/webhook'
      })
    });
    const data = await paymentRes.json();
    res.status(paymentRes.status).json(data);
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

app.listen(3001, () => console.log('Triple-A proxy backend listening on port 3001'));
