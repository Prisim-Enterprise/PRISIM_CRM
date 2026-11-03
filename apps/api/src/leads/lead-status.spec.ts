import { autoAdvance, statusForCallOutcome, validateManualTransition } from './lead-status';

describe('lead status rules', () => {
  it('only moves forward automatically', () => {
    expect(autoAdvance('ASSIGNED', 'CONTACT_ATTEMPTED')).toBe('CONTACT_ATTEMPTED');
    expect(autoAdvance('INTERESTED', 'CONTACT_ATTEMPTED')).toBeNull();
    expect(autoAdvance('CONTACTED', 'CONTACTED')).toBeNull();
  });

  it('never changes closed leads automatically', () => {
    expect(autoAdvance('CONVERTED', 'INTERESTED')).toBeNull();
    expect(autoAdvance('LOST', 'CONTACTED')).toBeNull();
  });

  it('requires a reason for lost / invalid / duplicate and for reopening', () => {
    expect(validateManualTransition('CONTACTED', 'LOST')).toMatch(/reason/);
    expect(validateManualTransition('CONTACTED', 'LOST', 'Budget')).toBeNull();
    expect(validateManualTransition('LOST', 'FOLLOW_UP_REQUIRED')).toMatch(/reopen/);
    expect(validateManualTransition('LOST', 'FOLLOW_UP_REQUIRED', 'Customer called back')).toBeNull();
  });

  it('blocks system-managed statuses and closed-to-closed moves', () => {
    expect(validateManualTransition('CONTACTED', 'ASSIGNED')).toMatch(/automatically/);
    expect(validateManualTransition('LOST', 'CONVERTED', 'x')).toMatch(/Reopen/);
  });

  it('maps call outcomes to statuses', () => {
    expect(statusForCallOutcome('NO_ANSWER')).toBe('CONTACT_ATTEMPTED');
    expect(statusForCallOutcome('INTERESTED')).toBe('INTERESTED');
    expect(statusForCallOutcome('CALLBACK')).toBe('FOLLOW_UP_REQUIRED');
  });
});
