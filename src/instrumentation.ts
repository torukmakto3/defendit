/**
 * Loaded in both the Node and Edge runtimes. The council check imports the
 * database (token and cost rows), which the Edge bundle cannot load, so it
 * stays behind the Node-only import.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}
