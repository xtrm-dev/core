// Stock AgentRun runner for the board audit: createPiRunner exactly as upstream ships.
//
// The CLI path needs no models.json change: createPiRunner -> createAgentSession adds the
// provider attribution headers itself. The host `agentrun` tool does not, which is why the
// tool's decide nodes fail with model_response_failed on this provider.
//
// Required env:
//   AGENTRUN_PI_ROOT  install root of @parcha/agentrun-pi, e.g. "$(npm root -g)/@parcha/agentrun-pi"
// Optional env:
//   PI_MODELS_PATH / PI_MODELS_STORE_PATH, MMD_AUDIT_MODEL (default opencode-go/deepseek-v4.1-flash)
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.AGENTRUN_PI_ROOT;
if (!root) throw new Error('AGENTRUN_PI_ROOT is required');

const runtimeModule = await import(pathToFileURL(path.join(
  root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'model-runtime.js')).href);
const runnerModule = await import(pathToFileURL(path.join(root, 'dist', 'runner.js')).href);

const runtime = await runtimeModule.ModelRuntime.create({
  refreshOnCreate: false,
  modelsPath: process.env.PI_MODELS_PATH ?? path.join(os.homedir(), '.pi', 'agent', 'models.json'),
  modelsStorePath: process.env.PI_MODELS_STORE_PATH
    ?? path.join(os.homedir(), '.local', 'state', 'mmd-board-audit', 'models-store.json'),
});

const [provider, modelId] = (process.env.MMD_AUDIT_MODEL ?? 'opencode-go/deepseek-v4.1-flash').split('/');
const model = runtime.models.getModel(provider, modelId);
if (!model) throw new Error(`model unavailable: ${provider}/${modelId}`);

export default {
  model,
  modelRuntime: runtime,
  thinkingLevel: 'low',
  tools: [],
  cwd: process.cwd(),
};
export const deps = {};
export const __createPiRunner = runnerModule.createPiRunner;
