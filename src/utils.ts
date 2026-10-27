export const sleep = (ms: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function computedStyle(this: void, element: HTMLElement | null) {
    if (!element) return null;
    return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
}

export function pixels(this: void, value: string | undefined): number {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A measured length as a CSS value, rounded to a hundredth of a pixel.
 *
 * Several lengths are derived from ratios of other measurements and come out
 * different in the ninth decimal place from one pass to the next. Published as
 * custom properties on the panel, which every element in it inherits, each of
 * those invisible changes restyled and relaid the entire panel: 150ms a pass on
 * a long note, several times per tab switch. Rounded, an unchanged layout
 * writes an unchanged value, which the browser ignores.
 */
export function toPx(this: void, value: number): string {
    return `${Math.round(value * 100) / 100}px`;
}

export function clamp(this: void, value: number, min: number, max: number) {
    return Math.max(min, Math.min(value, max));
}

type ThrottleOptions = {
    leading?: boolean;
    trailing?: boolean;
};

export function throttle<TArgs extends unknown[]>(
    fn: (...args: TArgs) => void,
    limit: number,
    options: ThrottleOptions = { leading: false, trailing: true }
) {
    let inThrottle = false;
    let lastArgs: TArgs | null = null;

    const invoke = () => {
        if (lastArgs) {
            const args = lastArgs;
            lastArgs = null;
            fn(...args);
            window.setTimeout(invoke, limit);
        } else {
            inThrottle = false;
        }
    };

    return (...args: TArgs) => {
        if (!inThrottle) {
            if (options.leading) {
                fn(...args);
            } else {
                lastArgs = args;
            }
            inThrottle = true;
            window.setTimeout(invoke, limit);
        } else if (options.trailing) {
            lastArgs = args;
        }
    };
}
