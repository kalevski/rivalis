import { AuthMiddleware } from '@rivalis/core'

class MyAuthMiddleware extends AuthMiddleware {

    override async validateTicket(ticket: string): Promise<boolean> {
        return ticket === 'test'
    }

    override async extractPayload(ticket: string): Promise<{ [x: string]: any } | Promise<null>> {
        return {
            userId: '20'
        }
    }

    override async getRoomId(ticket: string): Promise<string> {
        return 'my_first_room'
    }

}

export default MyAuthMiddleware