import { Command } from 'commander';
import { createSpecDraftCommand } from './spec/draft.js';
import { createSpecValidateCommand } from './spec/validate.js';

export function createSpecCommand(): Command {
    const cmd = new Command('spec')
        .description('xtrm spec — PRD-level intent artifacts that compile to bd issues via the planner specialist');
    cmd.addCommand(createSpecDraftCommand());
    cmd.addCommand(createSpecValidateCommand());
    return cmd;
}
