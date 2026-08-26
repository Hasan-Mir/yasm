import { Section } from '../src/createStore';
import { mergeUpdaterGenerator } from '../src/util';

type CounterState = { count: number; label: string };

const counterSection: Section<CounterState, Partial<CounterState>> = {
    initialState: { count: 0, label: '' },
    updater: mergeUpdaterGenerator<CounterState>()
};

const captureConsole = async (
    method: 'warn' | 'error' | 'debug',
    fn: () => void | Promise<void>
): Promise<string[]> => {
    const original = console[method];
    const messages: string[] = [];
    console[method] = (...args: unknown[]) => {
        messages.push(args.map(String).join(' '));
    };
    try {
        await fn();
    } finally {
        console[method] = original;
    }
    return messages;
};

const captureWarnings = (fn: () => void | Promise<void>) =>
    captureConsole('warn', fn);

export { counterSection, captureWarnings, captureConsole, type CounterState };
