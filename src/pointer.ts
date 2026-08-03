import type { ScrollMetrics } from "./scroll-model";
import { clamp } from "./utils";

/**
 * Click, drag and wheel handling over the minimap.
 *
 * The host supplies only what the gestures need — the elements to hit-test
 * against, the current geometry, and a way back into editor coordinates — so
 * this stays independent of how any of that is measured.
 */
export interface PointerHost {
    readonly container: HTMLElement | null;
    readonly slider: HTMLElement | null;
    readonly topOffset: number;
    readonly scale: number;
    readonly centerOnClick: boolean;
    getScroller(): HTMLElement | null;
    getScrollMetrics(): ScrollMetrics;
    /** Editor Y for a panel Y, or null when the global ratio should be used. */
    mapToEditor(minimapY: number): number | null;
    onScrolled(): void;
}

type DragMode = "thumb" | "document";

export class MinimapPointer {
    private readonly host: PointerHost;
    private dragging = false;
    private dragMode: DragMode = "document";
    /** Distance from the thumb's top to where it was grabbed. */
    private grabOffset = 0;

    constructor(host: PointerHost) {
        this.host = host;
    }

    attach(hitbox: HTMLElement) {
        hitbox.addEventListener("mousedown", this.onMouseDown);
        hitbox.addEventListener("wheel", this.onWheel, { passive: false });
        hitbox.addEventListener("mouseenter", this.onEnter);
        hitbox.addEventListener("mouseleave", this.onLeave);
    }

    detach(hitbox: HTMLElement | null) {
        hitbox?.removeEventListener("mousedown", this.onMouseDown);
        hitbox?.removeEventListener("wheel", this.onWheel);
        hitbox?.removeEventListener("mouseenter", this.onEnter);
        hitbox?.removeEventListener("mouseleave", this.onLeave);
        activeDocument.removeEventListener("mousemove", this.onMouseMove);
        activeDocument.removeEventListener("mouseup", this.onMouseUp);
    }

    // Driven from the hitbox rather than a :hover rule on the container: the
    // container is pointer-events: none, and relying on hover reaching it
    // through the one child that opts back in is a subtlety not worth betting
    // the behaviour on.
    private onEnter = () => {
        this.host.container?.classList.add("is-hovered");
    };

    private onLeave = () => {
        this.host.container?.classList.remove("is-hovered");
    };

    private onMouseDown = (event: MouseEvent) => {
        event.preventDefault();
        const slider = this.host.slider;
        const onThumb = this.isInsideSlider(event.clientY);
        this.dragging = true;
        this.dragMode = onThumb ? "thumb" : "document";
        slider?.classList.add("dragging");

        if (onThumb && slider) {
            // Grab the thumb where it was actually clicked and keep that offset
            // for the drag. Recentring it on the pointer instead makes an
            // off-centre grab jump, then sit dead until the pointer catches up.
            this.grabOffset =
                event.clientY - slider.getBoundingClientRect().top;
        } else {
            // A click on the track does move the view, to that position.
            this.grabOffset = 0;
            this.scrollToClientY(event.clientY);
        }

        activeDocument.addEventListener("mousemove", this.onMouseMove);
        activeDocument.addEventListener("mouseup", this.onMouseUp);
    };

    private onMouseMove = (event: MouseEvent) => {
        if (!this.dragging) return;
        this.scrollToClientY(event.clientY);
    };

    private onMouseUp = () => {
        this.dragging = false;
        this.host.slider?.classList.remove("dragging");
        activeDocument.removeEventListener("mousemove", this.onMouseMove);
        activeDocument.removeEventListener("mouseup", this.onMouseUp);
    };

    private onWheel = (event: WheelEvent) => {
        const scroller = this.host.getScroller();
        if (!scroller) return;
        event.preventDefault();
        scroller.scrollBy({
            left: event.deltaX,
            top: event.deltaY,
            behavior: "auto",
        });
        this.host.onScrolled();
    };

    private isInsideSlider(clientY: number) {
        const slider = this.host.slider;
        if (!slider) return false;
        const rect = slider.getBoundingClientRect();
        return clientY >= rect.top && clientY <= rect.bottom;
    }

    private scrollToClientY(clientY: number) {
        const container = this.host.container;
        const scroller = this.host.getScroller();
        if (!container || !scroller) return;
        const metrics = this.host.getScrollMetrics();
        if (metrics.maxScroll <= 0) return;

        const rect = container.getBoundingClientRect();
        const localY = clamp(
            clientY - rect.top - this.host.topOffset,
            0,
            metrics.activeHeight
        );
        const scrollTop =
            this.dragMode === "thumb"
                ? this.thumbScrollTop(localY, metrics)
                : this.documentScrollTop(localY, metrics);

        scroller.scrollTop = clamp(scrollTop, 0, metrics.maxScroll);
        this.host.onScrolled();
    }

    /**
     * Editor position for a point on the panel, through the same mapping that
     * placed the thumb. Using the track ratio instead leaves the thumb a few
     * pixels behind the pointer, because the mapping is piecewise and the
     * ratio is not its inverse.
     */
    private panelYToScrollTop(panelLocalY: number, metrics: ScrollMetrics) {
        const panelY = panelLocalY + metrics.minimapScrollOffset;
        const mapped = this.host.mapToEditor(
            panelY / Math.max(this.host.scale, 0.001)
        );
        return mapped ?? panelY / Math.max(metrics.docScale, 0.001);
    }

    /**
     * Dragging the thumb holds the point where it was grabbed under the
     * pointer. "Center on click" governs clicks on the track only — a grab on
     * the thumb should never move the view on its own.
     */
    private thumbScrollTop(localY: number, metrics: ScrollMetrics) {
        return this.panelYToScrollTop(localY - this.grabOffset, metrics);
    }

    /** Clicking the panel goes to the position under the pointer. */
    private documentScrollTop(localY: number, metrics: ScrollMetrics) {
        const documentY = this.panelYToScrollTop(localY, metrics);
        return this.host.centerOnClick
            ? documentY - metrics.clientHeight / 2
            : documentY;
    }
}
