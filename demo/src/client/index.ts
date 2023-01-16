import { WSClient } from '@rivalis/browser'
import serializer from '../serializer'

const client = new WSClient('ws://localhost:2334')

client.connect('test')
client.on('client:connect', (payload, topic) => {
    let message = serializer.encode('message', {
        payload: [
            { username: 'my user' }
        ]
    })
    client.send('message', message)
}, this)

client.on('client:disconnect', (payload, topic) => {
    console.log('disconnected', new TextDecoder().decode(payload))

}, this)