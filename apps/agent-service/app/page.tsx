export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>REOS Agent Service</h1>
      <p>Conversational layer for REOS on Salesforce.</p>
      <ul>
        <li>
          <a href="/api/health">GET /api/health</a>
        </li>
        <li>POST /api/webhooks/twilio — inbound SMS</li>
        <li>POST /api/webhooks/stripe — Connect splits (stub)</li>
      </ul>
    </main>
  );
}
