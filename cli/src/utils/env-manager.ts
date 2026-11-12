import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import kleur from 'kleur';
import dotenv from 'dotenv';

/**
 * Environment file location: ~/.config/jaggers-agent-tools/.env
 */
// CORE-2630: resolve these from HOME on every call. Module-load constants
// froze the target at import time, so a process that changes HOME afterwards
// (a test, a wrapper, sudo) kept writing to the original home.
//
// XDG_CONFIG_HOME is deliberately NOT honoured here. env-manager stores MCP
// server environment variables (~/.config/jaggers-agent-tools/.env), which is a
// tool-specific, well-known location rather than generic application config;
// env-paths/XDG semantics do not apply. Changing it would relocate existing
// .env files and break setups that rely on the fixed path.
function resolveConfigDir(): string {
    return path.join(os.homedir(), '.config', 'jaggers-agent-tools');
}
function resolveEnvFile(): string {
    return path.join(resolveConfigDir(), '.env');
}
function resolveEnvExampleFile(): string {
    return path.join(resolveConfigDir(), '.env.example');
}

interface EnvVarConfig {
    description: string;
    example: string;
    getUrl: () => string;
}

/**
 * Required environment variables for MCP servers
 */
const REQUIRED_ENV_VARS: Record<string, EnvVarConfig> = {
    CONTEXT7_API_KEY: {
        description: 'Context7 MCP server API key',
        example: 'ctx7sk-your-api-key-here',
        getUrl: () => 'https://context7.com/',
    },
};

/**
 * Ensure config directory and .env file exist
 */
export function ensureEnvFile(): boolean {
    // Create config directory if missing
    if (!fs.existsSync(resolveConfigDir())) {
        fs.ensureDirSync(resolveConfigDir());
        console.log(kleur.gray(`  Created config directory: ${resolveConfigDir()}`));
    }

    // Create .env.example if missing
    if (!fs.existsSync(resolveEnvExampleFile())) {
        createEnvExample();
    }

    // Create .env if missing
    if (!fs.existsSync(resolveEnvFile())) {
        createEnvFile();
        return false; // File was created (user needs to fill it)
    }

    return true; // File already exists
}

function createEnvExample(): void {
    const content = [
        '# Jaggers Agent Tools - Environment Variables',
        '# Copy this file to .env and fill in your actual values',
        '',
        ...Object.entries(REQUIRED_ENV_VARS).map(([key, config]) => {
            return [
                `# ${config.description}`,
                `# Get your key from: ${config.getUrl()}`,
                `${key}=${config.example}`,
                '',
            ].join('\n');
        }),
        '# See config/.env.example in the repository for all available options',
        '',
    ].join('\n');

    fs.writeFileSync(resolveEnvExampleFile(), content);
    console.log(kleur.gray(`  Created example file: ${resolveEnvExampleFile()}`));
}

function createEnvFile(): void {
    const content = [
        '# Jaggers Agent Tools - Environment Variables',
        '# Generated automatically by jaggers-agent-tools CLI',
        '',
        '# Copy values from .env.example and fill in your actual keys',
        '',
    ].join('\n');

    fs.writeFileSync(resolveEnvFile(), content);
    console.log(kleur.green(`  Created environment file: ${resolveEnvFile()}`));
}

/**
 * Load environment variables from .env file
 * Also loads from process.env (which takes precedence)
 */
export function loadEnvFile(): Record<string, string> {
    if (fs.existsSync(resolveEnvFile())) {
        const envConfig = dotenv.parse(fs.readFileSync(resolveEnvFile()));

        // Merge with process.env (process.env takes precedence)
        for (const [key, value] of Object.entries(envConfig)) {
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }

        return envConfig;
    }

    return {};
}

/**
 * Check if required environment variables are set.
 * Pass an optional `subset` of var names to check only those.
 * Known vars (in REQUIRED_ENV_VARS) get rich metadata; unknown vars are
 * still checked so server-defined ${VAR} references are never silently dropped.
 * Returns array of missing variable names.
 */
export function checkRequiredEnvVars(subset?: string[]): string[] {
    const missing: string[] = [];
    const keysToCheck = subset ?? Object.keys(REQUIRED_ENV_VARS);

    for (const key of keysToCheck) {
        if (!process.env[key]) {
            missing.push(key);
        }
    }

    return missing;
}

/**
 * Prompt user to enter missing environment variables interactively.
 * Saves provided values to .env and sets them in process.env.
 * Returns true if all missing vars were provided (sync can continue).
 */
export async function handleMissingEnvVars(missing: string[]): Promise<boolean> {
    if (missing.length === 0) {
        return true;
    }

    // @ts-ignore
    const prompts = (await import('prompts')).default;

    const answers: Record<string, string> = {};

    for (const key of missing) {
        const config = REQUIRED_ENV_VARS[key];
        if (config) {
            console.log(kleur.yellow(`\n  ⚠️  ${config.description} is required`));
            console.log(kleur.dim(`     Get your key from: ${config.getUrl()}`));
        } else {
            console.log(kleur.yellow(`\n  ⚠️  ${key} is required by a selected MCP server`));
        }

        const { value } = await prompts({
            type: 'text',
            name: 'value',
            message: `Enter ${key}:`,
            validate: (v: string) => v.trim().length > 0 || 'Value cannot be empty'
        });

        if (!value) {
            console.log(kleur.gray(`  Skipped — ${key} not provided. MCP server will be skipped.`));
            return false;
        }

        answers[key] = value.trim();
        process.env[key] = value.trim();
    }

    // Persist to .env file
    let envContent = fs.existsSync(resolveEnvFile()) ? fs.readFileSync(resolveEnvFile(), 'utf8') : '';
    for (const [key, value] of Object.entries(answers)) {
        const line = `${key}=${value}`;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, line);
        } else {
            envContent += `\n${line}\n`;
        }
    }
    fs.writeFileSync(resolveEnvFile(), envContent);
    console.log(kleur.green(`  ✓ Saved to ${resolveEnvFile()}`));

    return true;
}

export function getEnvFilePath(): string {
    return resolveEnvFile();
}

export function getConfigDir(): string {
    return resolveConfigDir();
}
