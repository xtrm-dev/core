import type { Command } from 'commander';

/** Add placement controls shared by fresh attach and primary launch commands. */
export function addPlacementOptions(command: Command): Command {
    return command
        .option('--window-name <name>', 'With --fresh, name the detached window')
        .option('--pane <target>', 'With --fresh, split into an existing window')
        .option('--workers', 'With --fresh, place in a workers* window')
        .option('--session <name>', 'With --fresh, select the placement session')
        .option('--layout <name>', 'With --fresh, select the placement layout');
}
