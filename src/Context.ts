import { createContext } from 'react';
import { Store } from './createStore';

/** React context holding the YASM store; provide it once at the root of your tree. */
const YasmContext = createContext<Store | undefined>(undefined);

export { YasmContext };
