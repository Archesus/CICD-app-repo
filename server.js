const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from CICD demo app\n');
}).listen(PORT, () => console.log(`Listening on ${PORT}`));

// Just a small change in the file
// Second change in the file to test automatic build and deployment