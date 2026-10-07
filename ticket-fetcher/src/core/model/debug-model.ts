import { IDebugModel, IDebugSection } from '@arcade-client/base-ticketfetcher-package';
import { injectable } from 'inversify';

@injectable()
export class DebugModel implements IDebugModel {
    public debugSections: IDebugSection[] = [
        // TODO: Replace the sections below with a Game Specific Sections and Responses.
        {
            sectionName: 'Main Game',
            responses: [
                {
                    name: 'No Win',
                    message: ''
                },
                {
                    name: 'Big Win',
                    message: '{"RequestType":"Resume","GameSettings":{"NumberOfPicks":12,"NumberOfCalls":20,"NumberOfBalls":60,"WinMultipliers":[20,0,0,0,0,1,2,5,25,50,200,500,500],"StakeOptions":[5,10,20,50,100],"DefaultStake":5,"Version":"1.1"},"GameMessage":{"ArcadeGameType":"Keno","Stake":100,"GameId":108462370,"Skin":"Numbers","Payout":50000,"Winner":true,"GameComplete":true,"Calls":[27,36,48,13,43,10,2,1,7,18,12,41,14,11,5,8,9,6,4,3],"Ticket":[2,5,6,12,13,18,27,36,41,43,48,50],"NumbersMatched":11,"PrizeMultiplier":0,"PlayMode":"Cash"},"ServiceDetails":{"ServiceB":"1.0.1686.0","ServiceA":"1.0.1147.0"},"PlayerData":{"Username":"mcstage123","PreStakeBalance":1109505,"StartBalance":1159405,"EndBalance":1159405,"FreePlayBalance":0,"PreviousStake":100},"ResultCode":{"ResultCode":0,"Description":"Success"},"PurchaseToken":0,"EngineDetails":{"LocalRng":"659","ExternalRng":"1686"},"SessionData":{"StartTime":"25/11/2022 15:31:58","StartTimeUnix":1669390318,"TotalSpend":0,"StartProfit":0,"EndProfit":0,"Status":{"ResultCode":0,"Description":"Success"}}}'
                }
            ]
        },
        {
            sectionName: 'FreePlay',
            responses: [
                {
                    name: 'No Win',
                    message: '{"RequestType":"Begin","GameSettings":{"GameOutcomes":[{"Dots":1,"Double":false,"WinType":"MatchToWin","NumberToMatch":5,"Multiplier":1},{"Dots":2,"Double":false,"WinType":"MatchToWin","NumberToMatch":5,"Multiplier":2},{"Dots":3,"Double":false,"WinType":"MatchToWin","NumberToMatch":5,"Multiplier":5},{"Dots":4,"Double":false,"WinType":"MatchToWin","NumberToMatch":5,"Multiplier":20},{"Dots":5,"Double":false,"WinType":"MatchToWin","NumberToMatch":5,"Multiplier":50},{"Dots":6,"Double":false,"WinType":"MatchToWin","NumberToMatch":5,"Multiplier":500},{"Dots":0,"Double":true,"WinType":"BonusTrigger","NumberToMatch":2,"Multiplier":0}],"BonusSettings":{"Multipliers":[0,1,2,5,10]},"WinMultipliers":[0,1,2,5,20,50,500,15],"StakeOptions":[5,10,20,50,100,200],"DefaultStake":5,"Version":"1.4","RTP":"97.99"},"GameMessage":{"ArcadeGameType":"Scratch","Stake":0,"GameId":6605,"Skin":"Dominoes","Payout":0,"Winner":false,"GameComplete":true,"Dominoes":[[4,2],[0,3],[2,6],[1,5],[4,3],[5,4],[2,5],[1,1],[3,2],[5,0]],"Results":[],"Bonus":false,"PlayMode":"FreePlay"},"ServiceDetails":{"ServiceB":"1.0.1845.0","ServiceA":"1.0.1415.0"},"PlayerData":{"Username":"mcdev123","PreStakeBalance":38578157,"StartBalance":38578157,"EndBalance":38578157,"FreePlayBalance":1,"PreviousStake":50},"ResultCode":{"ResultCode":0,"Description":"Success"},"RngStatus":{"Description":"WARNING: Queue Low"},"PromoDetails":[{"PromoId":1,"PromoNotification":true,"QualifiedForPromo":true,"PromoStartTime":"28/07/2023 12:06:27","PromoEndTime":"28/07/2023 12:08:27","TotalSpend":10,"PromoTicketId":"debug"}],"PurchaseToken":0,"EngineDetails":{"LocalRng":"679","ExternalRng":"1845"},"SessionData":{"StartTime":"28/07/2023 12:07:27","StartTimeUnix":1690546047,"TotalSpend":0,"StartProfit":0,"EndProfit":0,"Status":{"ResultCode":0,"Description":"Success"}}}'
                }
            ]
        }
    ];
}
