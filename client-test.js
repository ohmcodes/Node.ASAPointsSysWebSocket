const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:8080', {
  headers: { 'x-auth-token': 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET' }
});

ws.on('open', () => {
  ws.send('00023cc3b0ba4991b1bc137ec82e5509');     // <-- just the EOS_ID
});

ws.on('message', (d) => {
  console.log('Reply:', d.toString());
  ws.close();
});

ws.on('error', (e) => console.error('Error:', e.message));