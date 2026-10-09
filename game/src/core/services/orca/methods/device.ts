import { device, queryStringParams } from "@game-studio/arcade-base";
import sceneManager from '../scene-manager';

/**
 * Device Methods for FlowState
 * 
 * Provides access to device information including screen dimensions,
 * device type, browser capabilities, and environment settings.
 * 
 * Useful for:
 * - Responsive layout decisions
 * - Platform-specific behavior
 * - Feature detection
 * - Debug information
 */
class DeviceMethods {
    // =====================
    // Screen Dimensions
    // =====================

    /**
     * Get the game viewport width
     * @returns Width in pixels
     */
    public getGameWidth(): number {
        return device.gameWidth;
    }

    /**
     * Get the game viewport height
     * @returns Height in pixels
     */
    public getGameHeight(): number {
        return device.gameHeight;
    }

    /**
     * Get the device pixel ratio (for retina displays)
     * @returns Pixel ratio (e.g., 2 for retina)
     */
    public getPixelRatio(): number {
        return window.devicePixelRatio || 1;
    }

    /**
     * Get the aspect ratio of the game viewport
     * @returns Aspect ratio (width / height)
     */
    public getAspectRatio(): number {
        return device.gameWidth / device.gameHeight;
    }

    // =====================
    // Device Type Detection
    // =====================

    /**
     * Check if running on a mobile device
     * @returns true if mobile
     */
    public isMobile(): boolean {
        return device.type.isMobile || false;
    }

    /**
     * Check if running on a tablet device
     * @returns true if tablet
     */
    public isTablet(): boolean {
        return device.type.isTablet || false;
    }

    /**
     * Check if running on a desktop device
     * @returns true if desktop
     */
    public isDesktop(): boolean {
        return device.type.isDesktop || false;
    }

    /**
     * Check if running on a hybrid device (touch-enabled desktop)
     * @returns true if hybrid
     */
    public isHybrid(): boolean {
        return device.type.isHybrid || false;
    }

    /**
     * Check if the device supports touch input
     * @returns true if touch supported
     */
    public isTouchDevice(): boolean {
        return ('ontouchstart' in window);
    }

    // =====================
    // Orientation
    // =====================

    /**
     * Check if device is in portrait orientation
     * @returns true if portrait
     */
    public isPortrait(): boolean {
        return device.gameWidth < device.gameHeight;
    }

    /**
     * Check if device is in landscape orientation
     * @returns true if landscape
     */
    public isLandscape(): boolean {
        return device.gameWidth >= device.gameHeight;
    }

    /**
     * Get the current orientation as a string
     * @returns "portrait" or "landscape"
     */
    public getOrientation(): string {
        return this.isPortrait() ? 'portrait' : 'landscape';
    }

    /**
     * The canonical 3-way device mode: "desktop", "landscape" or "portrait".
     *
     * Prefer this over getOrientation() — that one is 2-way and measures the
     * chat-shrunk device.gameHeight, so it can report "portrait" for a
     * landscape viewport whenever the chat strip is open.
     * @returns "desktop" | "landscape" | "portrait"
     */
    public getDeviceMode(): string {
        return sceneManager.getActiveLayoutMode();
    }

    /**
     * Check whether the game is currently running in a given device mode.
     * @param mode "desktop", "landscape" or "portrait" (case/space lenient)
     * @returns true if it matches the current mode
     */
    public isDeviceMode(mode: string): boolean {
        return this.getDeviceMode() === String(mode ?? '').trim().toLowerCase();
    }

    // =====================
    // Environment / Query Params
    // =====================

    /**
     * Get the current locale/language code
     * @returns Locale string (e.g., "en-gb")
     */
    public getLocale(): string {
        return queryStringParams.locale || 'en-gb';
    }

    /**
     * Get the current skin name
     * @returns Skin identifier string
     */
    public getCurrentSkin(): string {
        return queryStringParams.currentSkin || '';
    }

    /**
     * Check if running in development environment
     * @returns true if development
     */
    public isDevelopment(): boolean {
        return process.env.NODE_ENV === 'development';
    }

    /**
     * Check if running in production environment
     * @returns true if production
     */
    public isProduction(): boolean {
        return process.env.NODE_ENV === 'production';
    }

    // =====================
    // Feature Detection
    // =====================

    /**
     * Check if WebGL is supported
     * @returns true if WebGL available
     */
    public supportsWebGL(): boolean {
        try {
            const canvas = document.createElement('canvas');
            return !!(window.WebGLRenderingContext && 
                (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if Web Audio API is supported
     * @returns true if Web Audio available
     */
    public supportsWebAudio(): boolean {
        return !!(window.AudioContext || (window as any).webkitAudioContext);
    }

    /**
     * Check if local storage is available
     * @returns true if local storage supported
     */
    public supportsLocalStorage(): boolean {
        try {
            localStorage.setItem('test', 'test');
            localStorage.removeItem('test');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if fullscreen API is supported
     * @returns true if fullscreen available
     */
    public supportsFullscreen(): boolean {
        return !!(document.documentElement.requestFullscreen ||
            (document.documentElement as any).webkitRequestFullscreen ||
            (document.documentElement as any).mozRequestFullScreen ||
            (document.documentElement as any).msRequestFullscreen);
    }

    // =====================
    // Fullscreen Control
    // =====================

    /**
     * Request fullscreen mode
     */
    public enterFullscreen(): void {
        const elem = document.documentElement;
        if (elem.requestFullscreen) {
            elem.requestFullscreen();
        } else if ((elem as any).webkitRequestFullscreen) {
            (elem as any).webkitRequestFullscreen();
        } else if ((elem as any).mozRequestFullScreen) {
            (elem as any).mozRequestFullScreen();
        } else if ((elem as any).msRequestFullscreen) {
            (elem as any).msRequestFullscreen();
        }
    }

    /**
     * Exit fullscreen mode
     */
    public exitFullscreen(): void {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
            (document as any).webkitExitFullscreen();
        } else if ((document as any).mozCancelFullScreen) {
            (document as any).mozCancelFullScreen();
        } else if ((document as any).msExitFullscreen) {
            (document as any).msExitFullscreen();
        }
    }

    /**
     * Check if currently in fullscreen mode
     * @returns true if fullscreen
     */
    public isFullscreen(): boolean {
        return !!(document.fullscreenElement ||
            (document as any).webkitFullscreenElement ||
            (document as any).mozFullScreenElement ||
            (document as any).msFullscreenElement);
    }

    /**
     * Toggle fullscreen mode
     */
    public toggleFullscreen(): void {
        if (this.isFullscreen()) {
            this.exitFullscreen();
        } else {
            this.enterFullscreen();
        }
    }

    // =====================
    // Performance Info
    // =====================

    /**
     * Get estimated device performance tier
     * @returns "low", "medium", or "high"
     */
    public getPerformanceTier(): string {
        const isMobile = this.isMobile() || this.isTablet();
        const pixelRatio = this.getPixelRatio();
        
        if (isMobile && pixelRatio < 2) return 'low';
        if (isMobile) return 'medium';
        return 'high';
    }
}

export const deviceInfo = new DeviceMethods();
