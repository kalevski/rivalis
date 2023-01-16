class AuthMiddleware {

    /**
     * 
     * @param {string} ticket 
     * @returns {Promise<boolean>}
     */
    async validateTicket(ticket) {
        return true
    }

    /**
     * 
     * @param {string} ticket 
     * @returns {Promise<Object<string,any>|Promise<null>>}
     */
    async extractPayload(ticket) {
        return null
    }


    /**
     * 
     * @param {string} ticket
     * @returns {Promise<string>} 
     */
    async getRoomId(ticket) {
        throw new Error('AuthMiddleware#getRoomId not implemented')
    }
}

export default AuthMiddleware