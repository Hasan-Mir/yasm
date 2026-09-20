import { useCallback, useContext } from 'react';

import { YasmContext } from './Context';
import { CloneSubtreeOptions, cloneYasmSubtree } from './clone';
import { Name, Section, Store } from './createStore';

/**
 * Returns a stable `cloneSubtree(sourcePrefix, targetPrefix, options?)` function
 * bound to the store found in React context.
 */
const useCloneYasmSubtree = <
    SM extends Record<Name, Section> = Record<Name, Section>
>() => {
    const store = useContext(YasmContext) as Store<SM> | undefined;

    if (store === undefined) {
        throw new Error(
            'YASM: no store was found in the React context. Wrap your component tree in <YasmContext.Provider value={store}>.'
        );
    }

    return useCallback(
        (
            sourcePrefix: string,
            targetPrefix: string,
            options?: CloneSubtreeOptions<SM>
        ) => {
            cloneYasmSubtree(store, sourcePrefix, targetPrefix, options);
        },
        [store]
    );
};

export { useCloneYasmSubtree };
