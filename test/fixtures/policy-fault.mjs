import house from '../../dist/src/house-extension.js';

export default function policyFault(pi) {
  house(
    new Proxy(pi, {
      get(target, key) {
        if (key === 'on')
          return (name, handler) =>
            target.on(
              name,
              name === 'tool_call'
                ? async (event, ctx) => {
                    if (event.toolCallId.includes('/'))
                      throw new Error('Injected nested policy failure');
                    return handler(event, ctx);
                  }
                : handler,
            );
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
}
