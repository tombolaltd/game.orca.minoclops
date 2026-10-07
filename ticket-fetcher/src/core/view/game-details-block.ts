import { GameDetailsBlock } from '@arcade-client/base-ticketfetcher-package';
import { injectable } from 'inversify';

/* 
    If this file hasnt changed once development is complete, then you can delete this file and in the default bindings, you can import
    GameDetailsBlock from the base-ticketfetcher-package and bind that instead.
*/

@injectable()
export class DetailsBlock extends GameDetailsBlock {
    constructor() {
        super();
    }

    public resizeBlock(blockWidth: number, blockHeight: number): void {
        super.resizeBlock(blockWidth, blockHeight);
    }

    // If the ticket fetcher has no slides due to showing the end game result initially then this function can be deleted.
    public update(val: number): void {
        super.update(val);
        /* 
            TODO: Change the text here depending on what value the slider is on.
        */
    }

    // Creation of any new components should be done here. If no additional components are needed, this file can be deleted.
    protected initialiseComponents(): void {
        super.initialiseComponents();
    }
}