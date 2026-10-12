// What the gate needs to keep the agent library in step (`@moss/agent/library`). Only the library and lifecycle
// modules: the gate holds the master key, so it must not load the runtime, the queue or the model clients.
export { ensureCoreSkills, loadLibrary, syncBuiltInSkills } from "./library.js";
export { ensureMoss, MOSS_TEMPLATE } from "./lifecycle.js";
