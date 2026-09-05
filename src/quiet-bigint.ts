const BIGINT_BINDING_WARNING = /bigint: Failed to load bindings/;

const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (args.length === 1 && typeof args[0] === "string" && BIGINT_BINDING_WARNING.test(args[0])) return;
  originalWarn(...args);
};
