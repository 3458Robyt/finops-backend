import https from 'node:https';

console.log("=== OCI Clock Skew Check ===");

const req = https.get('https://identity.sa-bogota-1.oci.oraclecloud.com', (res) => {
  const serverDateStr = res.headers.date;
  if (!serverDateStr) {
    console.error("No Date header received from OCI.");
    process.exit(1);
  }
  
  const serverDate = new Date(serverDateStr);
  const localDate = new Date();
  
  const diffMs = localDate.getTime() - serverDate.getTime();
  const diffMinutes = diffMs / 1000 / 60;
  
  console.log(`OCI Server Time : ${serverDate.toISOString()}`);
  console.log(`Local Time      : ${localDate.toISOString()}`);
  console.log(`Difference      : ${diffMinutes.toFixed(2)} minutes`);
  
  if (Math.abs(diffMinutes) > 4) {
    console.error("\n❌ WARNING: Your local clock is out of sync with OCI servers by more than 4 minutes.");
    console.error("OCI will reject all API requests with a 401 Unauthorized error if the difference is > 5 minutes.");
    console.error("Please sync your Windows clock (Settings > Time & Language > Date & Time > 'Sync now').");
  } else {
    console.log("\n✅ Clock sync is OK (difference is within acceptable limits).");
    console.log("The 401 error is NOT caused by clock skew. It must be an incorrect OCID, Fingerprint, or unassigned API key.");
  }
});

req.on('error', (e) => {
  console.error("Failed to connect to OCI:", e.message);
});
