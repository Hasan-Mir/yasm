import { YasmContext } from './Context';
import { useCallback, useContext } from 'react';
import { PurgeOptions, purgeYasmState } from './purge';

const usePurgeYasmState = () => {
    const store = useContext(YasmContext);

    if (store === undefined) {
        throw new Error(
            'YASM: no store was found in the React context. Wrap your component tree in <YasmContext.Provider value={store}>.'
        );
    }

    return useCallback(
        (pathPrefix: string, options?: PurgeOptions) =>
            purgeYasmState(store, pathPrefix, options),
        [store]
    );
};

export { usePurgeYasmState };
