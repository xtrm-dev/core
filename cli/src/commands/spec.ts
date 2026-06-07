import { Command } from 'commander';
import { createSpecDraftCommand } from './spec/draft.js';
import { createSpecValidateCommand } from './spec/validate.js';
import { createSpecDoctorCommand } from './spec/doctor.js';
import { createSpecApplyCommand } from './spec/apply.js';
import { createSpecStatusCommand } from './spec/status.js';
import { createSpecArchiveCommand } from './spec/archive.js';

export function createSpecCommand(): Command {
    const cmd = new Command('spec')
        .description('xtrm spec — PRD-level intent artifacts that compile to bd issues via the planner specialist');
    cmd.addCommand(createSpecDraftCommand());
    cmd.addCommand(createSpecValidateCommand());
    cmd.addCommand(createSpecDoctorCommand());
    cmd.addCommand(createSpecApplyCommand());
    cmd.addCommand(createSpecStatusCommand());
    cmd.addCommand(createSpecArchiveCommand());
    return cmd;
}
