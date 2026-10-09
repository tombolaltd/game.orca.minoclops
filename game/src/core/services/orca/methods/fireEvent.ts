import { eventEmitter, IGameServerResponse } from "@game-studio/arcade-base";

class GlobalFireEventMethods {
    public GLOBAL_TOAST_NOTIFICATION(message: string): void {
        eventEmitter.emit('GLOBAL_TOAST_NOTIFICATION', message);
    }

    public GLOBAL_SHOW_TIMEKEEPER(timeKeeperLimit: number): void {
        eventEmitter.emit('GLOBAL_SHOW_TIMEKEEPER', timeKeeperLimit);
    }

    public GLOBAL_SHOW_REALITYCHECK(realityCheckLimit: number): void {
        eventEmitter.emit('GLOBAL_SHOW_REALITYCHECK', realityCheckLimit);
    }

    public GLOBAL_LOW_BALANCE(balanceInPence: number, lowestStake?: number): void {
        eventEmitter.emit('GLOBAL_LOW_BALANCE', balanceInPence, lowestStake);
    }

    public GLOBAL_STAKE_ALERT(code: number): void {
        eventEmitter.emit('GLOBAL_STAKE_ALERT', code);
    }

    public GLOBAL_ACCOUNT_LOCKED(): void {
        eventEmitter.emit('GLOBAL_ACCOUNT_LOCKED');
    }

    public GLOBAL_ONE_HANDED_SETTING_CHANGED(): void {
        eventEmitter.emit('GLOBAL_ONE_HANDED_SETTING_CHANGED');
    }

    public GLOBAL_SUSPEND(): void {
        eventEmitter.emit('GLOBAL_SUSPEND');
    }

    public GLOBAL_RESUME(): void {
        eventEmitter.emit('GLOBAL_RESUME');
    }

    public GLOBAL_MENU_OPENED(): void {
        eventEmitter.emit('GLOBAL_MENU_OPENED');
    }

    public GLOBAL_ON_VALIDATION_ERROR(): void {
        eventEmitter.emit('GLOBAL_ON_VALIDATION_ERROR');
    }

    public GLOBAL_ORIENTATION_CHANGE(): void {
        eventEmitter.emit('GLOBAL_ORIENTATION_CHANGE');
    }

    public GLOBAL_FREE_PLAY_EARNED(newBalance: number): void {
        eventEmitter.emit('GLOBAL_FREE_PLAY_EARNED', newBalance);
    }

    public GLOBAL_FREE_PLAY_ENDED(payout: number, message: string): void {
        eventEmitter.emit('GLOBAL_FREE_PLAY_ENDED', payout, message);
    }

    public GLOBAL_SETTINGS_VISIBILITY_CHANGE(visible: boolean): void {
        eventEmitter.emit('GLOBAL_SETTINGS_VISIBILITY_CHANGE', visible);
    }

    public GLOBAL_LAZY_LOAD_COMPLETE(): void {
        eventEmitter.emit('GLOBAL_LAZY_LOAD_COMPLETE');
    }

    public GLOBAL_LAZY_INIT_COMPLETE(): void {
        eventEmitter.emit('GLOBAL_LAZY_INIT_COMPLETE');
    }

    public GLOBAL_LOADING_PROGRESS(progress: number): void {
        eventEmitter.emit('GLOBAL_LOADING_PROGRESS', progress);
    }

    public GLOBAL_LOADING_COMPLETE(): void {
        eventEmitter.emit('GLOBAL_LOADING_COMPLETE');
    }

    public GLOBAL_WALLET_UPDATED(): void {
        eventEmitter.emit('GLOBAL_WALLET_UPDATED');
    }

    public GLOBAL_SESSION_CREATED(status: any): void {
        eventEmitter.emit('GLOBAL_SESSION_CREATED', status);
    }

    public GLOBAL_DIM_SESSION_DATA(value: boolean): void {
        eventEmitter.emit('GLOBAL_DIM_SESSION_DATA', value);
    }
}

class PopupFireEventMethods {
    public POPUP_TOGGLE_HTP_POPUP(visibility?: boolean): void {
        eventEmitter.emit('POPUP_TOGGLE_HTP_POPUP', visibility);
    }

    public POPUP_TOGGLE_DEBUG_OVERLAY(visibility?: boolean): void {
        eventEmitter.emit('POPUP_TOGGLE_DEBUG_OVERLAY', visibility);
    }

    public POPUP_SHOW_SESSION(): void {
        // 'POPUP_SHOW_SESSION' in @game-studio/arcade-base requires an
        // ISubGameSessionInfo payload. The cast preserves this method so the
        // FlowState node menu can still expose it as a fireEvent node — at
        // runtime it is a no-op if no listener with a real payload is wired.
        eventEmitter.emit('POPUP_SHOW_SESSION' as any);
    }

    public POPUP_TOGGLE_GAME_INFO(visibility?: boolean): void {
        eventEmitter.emit('POPUP_TOGGLE_GAME_INFO', visibility);
    }

    public POPUP_TOGGLE_GAME_RULES(visibility: boolean): void {
        eventEmitter.emit('POPUP_TOGGLE_GAME_RULES', visibility);
    }

    public POPUP_TOGGLE_OLD_HTP(visibility: boolean): void {
        eventEmitter.emit('POPUP_TOGGLE_OLD_HTP', visibility);
    }

    public POPUP_SHOW_WALLET(response: IGameServerResponse): void {
        eventEmitter.emit('POPUP_SHOW_WALLET', response);
    }
}

class CabinetFireEventMethods {
    public CABINET_BEGIN_SENT(): void {
        eventEmitter.emit('CABINET_BEGIN_SENT');
    }

    public CABINET_BONUS_ACTION(action: string): void {
        eventEmitter.emit('CABINET_BONUS_ACTION', action);
    }

    public CABINET_REVEAL_NEXT(): void {
        eventEmitter.emit('CABINET_REVEAL_NEXT');
    }

    public CABINET_STAKE_CHANGE(): void {
        eventEmitter.emit('CABINET_STAKE_CHANGE');
    }

    public CABINET_START_REVEAL_ALL(): void {
        eventEmitter.emit('CABINET_START_REVEAL_ALL');
    }

    public CABINET_STOP_REVEAL_ALL(): void {
        eventEmitter.emit('CABINET_STOP_REVEAL_ALL');
    }
}

class CasinoCabinetFireEventMethods {
    public CASINO_CABINET_CLEAR(): void {
        eventEmitter.emit('CASINO_CABINET_CLEAR');
    }

    public CASINO_CABINET_UNDO(): void {
        eventEmitter.emit('CASINO_CABINET_UNDO');
    }

    public CASINO_CABINET_REPEAT(): void {
        eventEmitter.emit('CASINO_CABINET_REPEAT');
    }

    public CASINO_CABINET_CHIP_SELECTED(chipID: number): void {
        eventEmitter.emit('CASINO_CABINET_CHIP_SELECTED', chipID);
    }
}

class GameFireEventMethods {
    public GAME_BEGIN(isAutoBuying: boolean): void {
        eventEmitter.emit('GAME_BEGIN', isAutoBuying);
    }

    public GAME_COMPLETE(): void {
        eventEmitter.emit('GAME_COMPLETE');
    }

    public GAME_JACKPOT_WIN(prize: number): void {
        eventEmitter.emit('GAME_JACKPOT_WIN', prize);
    }

    public GAME_SWIPE_TO_BUY(): void {
        eventEmitter.emit('GAME_SWIPE_TO_BUY');
    }

    public GAME_DEMO_OUT_OF_PLAYS(): void {
        eventEmitter.emit('GAME_DEMO_OUT_OF_PLAYS');
    }
}

class ChatFireEventMethods {
    public CHAT_TOGGLE_FULL_SCREEN(): void {
        eventEmitter.emit('CHAT_TOGGLE_FULL_SCREEN');
    }

    public CHAT_UPDATE_HEIGHT(duration: number): void {
        // 'CHAT_UPDATE_HEIGHT' is not in the current @game-studio/arcade-base
        // event union (renamed/removed in a newer base package). The cast
        // preserves this method so the FlowState node menu can still expose it
        // as a fireEvent node — at runtime it is a no-op if no listener exists.
        eventEmitter.emit('CHAT_UPDATE_HEIGHT' as any, duration);
    }
}

class CustomFireEventMethods {
    /**
     * Fire a user-defined custom event by name, carrying an OPTIONAL
     * author-defined payload.
     *
     * @param eventName - the project custom-event name to emit.
     * @param propertyNames - ordered payload KEY names (exported as a `TArray`),
     *                        mirroring the event's `passProps` declaration in
     *                        `main.orca.customEvents[i]`.
     * @param values - the matching payload values; `values[i]` pairs with
     *                 `propertyNames[i]` BY INDEX.
     *
     * Why the payload is positional
     * -----------------------------
     * The editor exports this node's `properties[]` in this exact order:
     *
     *   [0] { name: 'eventName',     type: 'T',      value: 'MyEvent' }
     *   [1] { name: 'propertyNames', type: 'TArray', value: ['amount', 'isBig'] }
     *   [2] { name: 'part0',         type: 'T',      value: 12 }
     *   [3] { name: 'part1',         type: 'T',      value: true }
     *   ...
     *
     * `Flowstate.executeNode` resolves `properties[]` STRICTLY POSITIONALLY and
     * spreads them into the method (`await method(...params)`) — property NAMES
     * never reach the method — hence the leading `propertyNames` array plus a
     * rest parameter of values, zipped back together BY INDEX below. Same shape
     * as `methods/continue.ts sendContinueRequest`.
     *
     * Pairs with a blank/whitespace key name are skipped; later duplicate keys
     * overwrite earlier ones. A `propertyNames` that is not an array (including
     * the LEGACY single-argument export, where it arrives `undefined`) is
     * treated as "no pass-props" — the event still fires with an empty `{}`.
     *
     * Pairs with the `onCustomEvent` starter node, which listens on
     * `eventEmitter` for the same name and forwards this payload object into
     * the walker as the starter's value-output args (see
     * event-triggers/custom-events.ts). The casts are required because
     * `eventEmitter` is typed to a fixed event union — custom event names are
     * author-defined and intentionally outside it, and so is the shape of the
     * payload argument they carry.
     */
    public fireCustomEvent(eventName: string, propertyNames?: unknown, ...values: unknown[]): void {
        if (!eventName || typeof eventName !== 'string' || !eventName.trim()) {
            console.warn('[FlowState] fireCustomEvent called without a valid eventName — no-op');
            return;
        }

        const names = Array.isArray(propertyNames) ? propertyNames : [];
        const payload: Record<string, unknown> = {};
        for (let i = 0; i < names.length; i++) {
            const rawName = names[i];
            const key = rawName === null || rawName === undefined ? '' : String(rawName).trim();
            if (!key) continue;
            payload[key] = values[i];
        }

        // Always pass the payload object — an empty `{}` for a no-pass-prop or
        // legacy event — so the listen side has one uniform argument shape.
        eventEmitter.emit(eventName as any, payload as any);
    }
}

export const globalFireEvents = new GlobalFireEventMethods();
export const popupFireEvents = new PopupFireEventMethods();
export const cabinetFireEvents = new CabinetFireEventMethods();
export const casinoCabinetFireEvents = new CasinoCabinetFireEventMethods();
export const gameFireEvents = new GameFireEventMethods();
export const chatFireEvents = new ChatFireEventMethods();
export const customFireEvents = new CustomFireEventMethods();
