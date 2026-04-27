class AuthMiddleware<TActorData = Record<string, unknown>> {

    async validateTicket(_ticket: string): Promise<boolean> {
        return true
    }

    async extractPayload(_ticket: string): Promise<TActorData | null> {
        return null
    }

    async getRoomId(_ticket: string): Promise<string> {
        throw new Error('AuthMiddleware#getRoomId not implemented')
    }
}

export default AuthMiddleware
