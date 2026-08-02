import { createContext } from 'react';
import { Store } from './createStore';

const YasmContext = createContext<Store | undefined>(undefined);

export { YasmContext };
