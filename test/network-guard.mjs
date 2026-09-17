// Unit tests must mock their transports. Prevent accidental provider credit
// usage even when a test imports a module that reads the developer's config.
import net from "node:net";
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  // The SDK initializes its bundled WASM decoder through a data URL.
  if (url.startsWith("data:")) return localFetch(input, init);
  throw new Error("Network disabled in unit tests: mock fetch explicitly");
};
net.Socket.prototype.connect = function () {
  throw new Error("Network disabled in unit tests: mock the socket transport");
};
