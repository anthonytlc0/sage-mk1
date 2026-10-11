// TODO(T23): the app shell replaces this file (bootApp). Until then the entry only keeps a reference to the engine, so
// the build bundles the AudioWorklet and its whole import graph, and the dev server can start it from the console
// after a click: `await sageEngine.start()`.
import { EngineHost } from './engine/host';

(globalThis as { sageEngine?: typeof EngineHost }).sageEngine = EngineHost;
