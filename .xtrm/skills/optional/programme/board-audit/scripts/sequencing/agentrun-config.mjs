// Stock AgentRun runner for programme sequencing: createPiRunner exactly as upstream ships (same as board-audit/scripts/agentrun-config-stock.mjs).
// Required env: AGENTRUN_PI_ROOT. Optional: PI_MODELS_PATH, PI_MODELS_STORE_PATH, MMD_AUDIT_MODEL (default opencode-go/deepseek-v4.1-flash).
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.AGENTRUN_PI_ROOT;
if (!root) throw new Error('AGENTRUN_PI_ROOT is required');
const runtimeModule = await import(pathToFileURL(path.join(
  root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'model-runtime.js')).href);

const runtime = await runtimeModule.ModelRuntime.create({
  refreshOnCreate: false,
  modelsPath: process.env.PI_MODELS_PATH ?? path.join(os.homedir(), '.pi', 'agent', 'models.json'),
  modelsStorePath: process.env.PI_MODELS_STORE_PATH ?? path.join(os.homedir(), '.local', 'state', 'mmd-programme-seq', 'models-store.json'),
});
const spec = process.env.MMD_AUDIT_MODEL ?? 'commandcode/deepseek/deepseek-v4.1-flash';
const cut = spec.indexOf('/');
const [provider, modelId] = [spec.slice(0, cut), spec.slice(cut + 1)];
const model = runtime.getModel(provider, modelId);
if (!model) throw new Error(`model unavailable: ${provider}/${modelId}`);
export default { model, modelRuntime: runtime, thinkingLevel: 'low', tools: [], cwd: process.cwd() };
export const deps = {};
