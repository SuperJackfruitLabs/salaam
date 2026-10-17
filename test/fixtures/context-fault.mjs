import house from '../../dist/src/house-extension.js';

export default function contextFault(pi) {
  house(
    new Proxy(pi, {
      get(target, key) {
        if (key === 'on')
          return (event, handler) =>
            target.on(
              event,
              event === 'context'
                ? () => {
                    throw new Error('Injected context failure');
                  }
                : handler,
            );
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
}
