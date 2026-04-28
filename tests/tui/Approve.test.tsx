import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Approve } from '../../src/tui/approve/Approve.tsx';

const OLD = 'PROGRAM PLC_PRG\nVAR\n  counter : INT := 0;\nEND_VAR';
const NEW = 'PROGRAM PLC_PRG\nVAR\n  counter : DINT := 0;\n  overflow : BOOL;\nEND_VAR';

describe('<Approve>', () => {
  it('renders both deletions and additions in a unified diff', () => {
    const { lastFrame } = render(
      <Approve fileName="PLC_PRG.st" oldText={OLD} newText={NEW} onDecision={() => {}} />
    );
    const out = lastFrame()!;
    expect(out).toContain('counter : INT := 0;');
    expect(out).toContain('counter : DINT := 0;');
    expect(out).toContain('overflow : BOOL;');
    expect(out).toMatch(/Approve change\? PLC_PRG\.st/);
  });

  it('reports add/del totals in the header', () => {
    const { lastFrame } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={() => {}} />
    );
    const out = lastFrame()!;
    expect(out).toMatch(/\+ 2 lines.*− 1 lines/);
  });

  const flush = () => new Promise<void>((r) => setImmediate(r));

  it('calls onDecision("accept") when y is pressed', async () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    await flush();
    stdin.write('y');
    await flush();
    expect(decision).toHaveBeenCalledWith('accept');
  });

  it('calls onDecision("reject") when n is pressed', async () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    await flush();
    stdin.write('n');
    await flush();
    expect(decision).toHaveBeenCalledWith('reject');
  });

  it('calls onDecision("reject") when q is pressed', async () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    await flush();
    stdin.write('q');
    await flush();
    expect(decision).toHaveBeenCalledWith('reject');
  });

  it('calls onDecision("reject") on escape', async () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    await flush();
    stdin.write(String.fromCharCode(27));
    await flush();
    expect(decision).toHaveBeenCalledWith('reject');
  });
});
