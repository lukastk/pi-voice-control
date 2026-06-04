// Throwaway: dial a pi-rpc unix socket and print {getState:true} reply.
// Usage: node probe-socket.mjs /tmp/pi-rpc-sockets/<uuid>.sock
import net from "node:net";
const p = process.argv[2];
const c = net.createConnection(p, () => c.write(JSON.stringify({ getState: true }) + "\n"));
let buf = "";
const t = setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 1500);
c.on("data", (d) => {
  buf += d.toString();
  const nl = buf.indexOf("\n");
  if (nl >= 0) { clearTimeout(t); console.log(buf.slice(0, nl)); c.end(); process.exit(0); }
});
c.on("error", (e) => { clearTimeout(t); console.log("ERROR " + e.message); process.exit(1); });
