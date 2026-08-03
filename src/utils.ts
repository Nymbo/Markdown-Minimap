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

export function toRGBAAlpha(this: void, color: string, alpha: number): string {
    if (color.startsWith("#")) {
        // hex to rgb
        let hex = color.replace("#", "");
        if (hex.length === 3)
            hex = hex
                .split("")
                .map((x) => x + x)
                .join("");
        const num = parseInt(hex, 16);
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r},${g},${b},${alpha})`;
    } else if (color.startsWith("rgb")) {
        // rgb or rgba
        const nums = color.match(/[\d.]+/g);
        if (nums && nums.length >= 3) {
            return `rgba(${nums[0]},${nums[1]},${nums[2]},${alpha})`;
        }
    }
    // fallback
    return color;
}
