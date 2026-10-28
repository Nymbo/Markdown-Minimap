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
    /** Omit the argument for the current position, pass one to ask "what if". */
    getScrollMetrics(scrollTop?: number): ScrollMetrics;
    /** Editor Y for a panel Y, or null when the global ratio should be used. */
    mapToEditor(minimapY: number): number | null;
    /**
     * Take the editor to the position drawn at `localY`, as a document
     * position. Returns false when only the pixel mapping can answer.
     */
    jumpToPosition(
        localY: number,
        metrics: ScrollMetrics,
        center: boolean
    ): boolean;
    onScrolled(): void;
}

type DragMode = "thumb" | "document";

export class MinimapPointer {
    private readonly host: PointerHost;
    private dragging = false;
    private dragMode: DragMode = "document";

    /** Whether a gesture is in progress, which owns the scroll until it ends. */
    isDragging() {
        return this.dragging;
    }
    /**
     * Where the thumb was grabbed, as a fraction of its height. The thumb
     * resizes as it moves, because its height is the slice of the note the
     * viewport covers; holding an absolute pixel offset instead let the
     * grabbed point drift out from under the pointer during a fast drag.
     */
    private grabFraction = 0;
    /**
     * The grab as a fixed distance from the thumb's top instead, for a drag
     * that began as a track click. The pointer can then be well clear of the
     * thumb, and a fraction that far outside it would multiply every change in
     * the thumb's height into a jump.
     */
    private grabPixels: number | null = null;
    /**
     * A click on the track jumps to what is drawn under the pointer, and the
     * rest of the gesture is then a thumb drag held from where the jump left
     * the thumb. Re-reading what is under the pointer on every move instead
     * feeds back on itself: the jump slides the panel, which puts new content
     * under a pointer that has not moved, and a held or slowly dragged pointer
     * runs away down the note.
     *
     * CodeMirror applies the jump on its next frame, so the thumb is only
     * where it will be grabbed one frame later. Until then the pointer is just
     * recorded, and a release in the meantime still lands where it ended.
     */
    private handoffFrame = 0;
    private handoffWindow: Window | null = null;
    private downY = 0;
    private lastY = 0;

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
        this.cancelHandoff();
    }

    private cancelHandoff() {
        if (this.handoffFrame) {
            this.handoffWindow?.cancelAnimationFrame(this.handoffFrame);
        }
        this.handoffFrame = 0;
        this.handoffWindow = null;
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
        this.cancelHandoff();
        const slider = this.host.slider;
        const onThumb = this.isInsideSlider(event.clientY);
        this.dragging = true;
        this.dragMode = onThumb ? "thumb" : "document";
        this.grabPixels = null;
        slider?.classList.add("dragging");

        if (onThumb && slider) {
            // Grab the thumb where it was actually clicked and hold that point
            // for the drag. Recentring it on the pointer instead makes an
            // off-centre grab jump, then sit dead until the pointer catches up.
            const rect = slider.getBoundingClientRect();
            this.grabFraction =
                rect.height > 0
                    ? (event.clientY - rect.top) / rect.height
                    : 0;
        } else {
            // A click on the track does move the view, to that position.
            this.grabFraction = 0;
            if (this.scrollToClientY(event.clientY, true)) {
                this.downY = event.clientY;
                this.lastY = event.clientY;
                this.handoffWindow = activeWindow;
                this.handoffFrame = activeWindow.requestAnimationFrame(
                    this.handOff
                );
            }
        }

        activeDocument.addEventListener("mousemove", this.onMouseMove);
        activeDocument.addEventListener("mouseup", this.onMouseUp);
    };

    /** Continue a track click as a thumb drag, from where the jump landed. */
    private handOff = () => {
        this.handoffFrame = 0;
        this.handoffWindow = null;
        // Bring the thumb to the jump before it is measured; the scroll event
        // that would otherwise do it arrives a frame later still.
        this.host.onScrolled();
        const rect = this.host.slider?.getBoundingClientRect();
        if (!rect || rect.height <= 0) return;
        // The thumb need not be under the pointer — the panel has slid since
        // the click — so the grab can sit outside it. What matters is that the
        // thumb then moves exactly as far as the pointer does.
        this.grabPixels = this.downY - rect.top;
        this.dragMode = "thumb";
        if (this.lastY !== this.downY) this.scrollToClientY(this.lastY);
    };

    private onMouseMove = (event: MouseEvent) => {
        if (!this.dragging) return;
        if (this.handoffFrame) {
            this.lastY = event.clientY;
            return;
        }
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

    /**
     * `jump` asks for the document position under the pointer rather than a
     * scroll offset computed from it. A click wants the position; a drag wants
     * the offset, because the pointer is already moving and every pixel it
     * covers has to be followed.
     *
     * Returns true when it jumped, which leaves the scroll to CodeMirror.
     */
    private scrollToClientY(clientY: number, jump = false): boolean {
        const container = this.host.container;
        const scroller = this.host.getScroller();
        if (!container || !scroller) return false;
        const metrics = this.host.getScrollMetrics();
        if (metrics.maxScroll <= 0) return false;

        const rect = container.getBoundingClientRect();
        const localY = clamp(
            clientY - rect.top - this.host.topOffset,
            0,
            metrics.activeHeight
        );

        // Asked for a destination, name one. CodeMirror re-measures as it
        // scrolls, so a position survives a height map that under-estimates the
        // note; a pixel worked out from that same map does not.
        if (
            jump &&
            this.dragMode === "document" &&
            this.host.jumpToPosition(localY, metrics, this.host.centerOnClick)
        ) {
            this.host.onScrolled();
            return true;
        }

        const scrollTop =
            this.dragMode === "thumb"
                ? this.thumbScrollTop(localY, metrics)
                : this.documentScrollTop(localY, metrics);

        scroller.scrollTop = clamp(scrollTop, 0, metrics.maxScroll);
        this.host.onScrolled();
        return false;
    }

    /**
     * Editor position for an absolute position in the panel, through the same
     * mapping that placed the thumb. Using the track ratio instead leaves the
     * thumb a few pixels behind the pointer, because the mapping is piecewise
     * and the ratio is not its inverse.
     */
    private mappedTopToScrollTop(mappedTop: number, metrics: ScrollMetrics) {
        const mapped = this.host.mapToEditor(
            mappedTop / Math.max(this.host.scale, 0.001)
        );
        return mapped ?? mappedTop / Math.max(metrics.docScale, 0.001);
    }

    /**
     * Where to scroll so the thumb ends up at `trackY` once we get there.
     *
     * On a note long enough to pan, the panel slides as it scrolls, so the
     * answer depends on the position being solved for. Solving with only the
     * current pan lands short, which made repeated clicks creep toward the
     * target instead of arriving.
     *
     * Panning is a fixed fraction of the thumb's travel, so thumb position is a
     * linear function of the mapped position and can be inverted outright.
     * Iterating instead converges slowly, because the pan chases the target
     * almost as fast as the target moves. One refinement pass absorbs the
     * slight variation in thumb height along the note.
     */
    private solveScrollTop(
        trackY: number,
        /** How far below the thumb's top `trackY` lands, for a given height. */
        grabOf: (sliderHeight: number) => number,
        metrics: ScrollMetrics
    ) {
        // Without panning the thumb tracks the mapped position one to one.
        const slopeOf = (m: ScrollMetrics) => {
            const maxPan = Math.max(
                0,
                m.scaledDocumentHeight - m.activeHeight
            );
            const span = m.scaledDocumentHeight - m.viewportExtent;
            const slope =
                maxPan > 0 && span > 0
                    ? (m.activeHeight - m.viewportExtent) / span
                    : 1;
            return Math.max(slope, 0.0001);
        };
        // Resolved against the thumb's current height, which changes as it
        // moves, so the grabbed point stays under the pointer.
        const wantedOf = (m: ScrollMetrics) => trackY - grabOf(m.sliderHeight);

        let current = metrics;
        let mappedTop = wantedOf(current) / slopeOf(current);
        let target = current.scrollTop;

        for (let pass = 0; pass < 3; pass++) {
            target = clamp(
                this.mappedTopToScrollTop(mappedTop, current),
                0,
                current.maxScroll
            );
            const next = this.host.getScrollMetrics(target);
            // Correct against where the thumb would actually land, rather than
            // trusting the inversion: thumb height varies along the note, so
            // the slope is only locally right.
            const landed = next.mappedTop - next.minimapScrollOffset;
            const error = wantedOf(next) - landed;
            if (Math.abs(error) < 0.5) break;
            mappedTop += error / slopeOf(next);
            current = next;
        }
        return target;
    }

    /**
     * Dragging the thumb holds the point where it was grabbed under the
     * pointer. "Center on click" governs clicks on the track only — a grab on
     * the thumb should never move the view on its own.
     */
    private thumbScrollTop(localY: number, metrics: ScrollMetrics) {
        const grabPixels = this.grabPixels;
        return this.solveScrollTop(
            localY,
            (height) => grabPixels ?? this.grabFraction * height,
            metrics
        );
    }

    /** Clicking the panel goes to the position under the pointer. */
    private documentScrollTop(localY: number, metrics: ScrollMetrics) {
        const fraction = this.host.centerOnClick ? 0.5 : 0;
        return this.solveScrollTop(
            localY,
            (height) => fraction * height,
            metrics
        );
    }
}
