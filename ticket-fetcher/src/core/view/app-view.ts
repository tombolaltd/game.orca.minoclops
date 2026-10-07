import { BaseAppView } from '@arcade-client/base-ticketfetcher-package';
import { injectable } from 'inversify';

@injectable()
export class AppView extends BaseAppView {
    public init(): void {
        super.init();
        // TODO: Place Any Component Creation Here

        // TODO: Then Call Resize
        this.resize();

        this.buildVersionText();
    }
    
    public resize(): void {
        super.resize();

        // TODO: Resize any Game Components Here
    }

    protected buildVersionText(): void { 
        this.addChild(this._versionText);
    }
}