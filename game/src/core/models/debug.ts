import { eventEmitter, IBaseDebugModel, IDebugSettingType } from '@game-studio/arcade-base';
import { orcaFireDebugEvent, ORCA_DEBUG_EVENT_BUTTONS, ORCA_DEBUG_MODEL_PROPERTY_SETTINGS, ORCA_DEBUG_TICKET_OPTIONS, orcaDebugServerSettingOptions, orcaDebugServerDataActive, orcaDebugServerData } from '../services/orca/generated-debug-options';
import { setGameModelProperty, setSettingsModelProperty } from '../services/orca/methods/model';
import { IS_JACKPOT } from '../services/orca/active-skin';
import { jackpotDebugSettingOptions, jackpotWinDebugData } from '../services/jackpots/jackpots-runtime';

// This should describe the structure the Server is expecting to force game states
export interface IDebugData {
    // Legacy/simple forced ticket
    DebugTicket?: number[];

    // Specifies the stopping symbol for each main game reel from left to right
    DebugStops?: number[];

    // ** The 2 properties below must either both be sent, or neither **
    // Specifies the stopping symbols for each bonus spin in order
    DebugBonusStops?: number[][];
    // Specifies the number reel (1-5) for each bonus spin that will be the expanding wild
    DebugBonusWildReels?: number[];

    DebugJackpotTier?: string;
    DebugJackpotForceWin?: boolean;
}

export interface IDebugOption {
    name: string;
    data?: IDebugData;
    // Marks a "fire custom event" button authored in the Orca editor's Debug
    // Panel. Such an option fires its event on click (see `updateDebugOption`)
    // and NEVER becomes `selectedOption`.
    orcaEventName?: string;
}

export class DebugModel implements IBaseDebugModel {
    public static get Instance(): DebugModel {
        return this._instance || (this._instance = new DebugModel());
    }
    private static _instance: DebugModel;

    // Options authored in the Orca editor under "View > Debug Panel" are
    // spread in from the auto-generated `generated-debug-options.ts`. You can
    // still hand-author extra options in this array alongside the spread —
    // the editor only ever rewrites the generated file, never this one.
    public readonly debugTicketOptions: IDebugOption[] = [
        {
            name: 'Clear'
        },
        // Some example options
        /* {
            name: 'No-Win',
            data: {
                DebugStops: [1, 2, 3, 4, 5]
            }
        }, */
        ...(ORCA_DEBUG_TICKET_OPTIONS as unknown as IDebugOption[]),
        // "Fire custom event" buttons authored in the Orca editor (View > Debug Panel).
        // They live here because a ticket option is what the arcade-base debug view
        // renders as a clickable row; `updateDebugOption` fires the event instead of
        // selecting them.
        ...(ORCA_DEBUG_EVENT_BUTTONS.map(b => ({ name: b.name, orcaEventName: b.eventName })) as unknown as IDebugOption[])
    ];

    // Merged into the outgoing debug data by the "jackpot win" setting below.
    private currentJackpotDebug: IDebugData | null = null;

    // Same again — hand-authored settings can live alongside the generated ones.
    debugSettingOptions: IDebugSettingType[] = [
        // Example setting - could change something on the gameModel, etc...
        // {
        //     name: 'Example',
        //     availableValues: ['None', 'On'],
        //     currentValue: 0,
        //     onChange: (s: any) => { console.log('do something...', s.currentValue); },
        //     type: 'enum'
        // } as unknown as IDebugSettingType,
        // Model-property enums authored in the Orca editor (View > Debug Panel).
        // Index 0 is the inert 'None' entry, so choice N sits at currentValue N+1.
        ...ORCA_DEBUG_MODEL_PROPERTY_SETTINGS.map((setting) => ({
            name: setting.name,
            availableValues: ['None', ...setting.choices.map((c) => c.label)],
            currentValue: 0,
            onChange: (s: any) => {
                const choice = setting.choices[s.currentValue - 1];
                if (!choice) return;
                if (choice.target === 'settingsModel') {
                    setSettingsModelProperty(choice.propertyName as any, choice.value as any);
                } else {
                    setGameModelProperty(choice.propertyName as any, choice.value as any);
                }
            },
            type: 'enum'
        }) as unknown as IDebugSettingType),
        // Real-engine jackpot tier forcing. Only offered when the booting skin is a jackpot skin.
        ...(IS_JACKPOT ? [{
            name: 'jackpot win',
            availableValues: ['None', 'Low', 'Mid', 'High'],
            currentValue: 0,
            onChange: (s: any) => {
                const tier = s.availableValues[s.currentValue];
                this.currentJackpotDebug = jackpotWinDebugData(tier);
            },
            type: 'enum'
        } as unknown as IDebugSettingType] : []),
        // Server debug settings from the Debug Panel: dropdowns / sliders that
        // build the debug data sent to the server (see debugServerData).
        ...(orcaDebugServerSettingOptions() as unknown as IDebugSettingType[]),
        // Jackpot skins: buttons that play a jackpot round now, without the server.
        ...jackpotDebugSettingOptions(),
    ];

    // Initialise to the empty option
    public selectedOption: IDebugOption = this.debugTicketOptions[0];

    public get shouldSendDebugData(): boolean {
        return this.selectedOption.data !== undefined || this.currentJackpotDebug !== null || orcaDebugServerDataActive();
    }

    public get debugServerData(): IDebugData | undefined {
        return { ...orcaDebugServerData(), ...this.selectedOption.data, ...this.currentJackpotDebug };
    }

    public updateDebugOption(option: IDebugOption): void {
        // Orca: Debug Panel "fire custom event" buttons fire immediately and never
        // become the selected ticket option.
        if (orcaFireDebugEvent(option)) return;

        // Update the model
        this.selectedOption = option;

        // Fire the TOGGLE_DEBUG_OVERLAY event with the param false to tell the package to hide the debug view
        eventEmitter.emit('POPUP_TOGGLE_DEBUG_OVERLAY', false);
    }
}

export const debugModel = DebugModel.Instance;
