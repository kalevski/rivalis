import { WSClient } from '@rivalis/browser'
import serializer from '../serializer'


const client = new WSClient('wss://localhost')

client.connect('test')
client.on('client:connect', (payload, topic) => {
    console.log('connected')
}, this)

client.on('client:disconnect', (payload, topic) => {
    console.log('disconnected', new TextDecoder().decode(payload))
    
}, this)


let button = document.getElementById('send') as HTMLButtonElement
button.addEventListener('click', (event) => {
    client.send('distance.update2')
})

let decodeText = document.getElementById('decode_text') as HTMLTextAreaElement
let decodeButton = document.getElementById('decode') as HTMLButtonElement

decodeButton.addEventListener('click', (event) => {
    let text = decodeText.value
    let bytes = text.split(' ').filter(bytes => bytes.length === 2).map(bytes => parseInt(bytes, 16))
    let buffer = new Uint8Array(bytes)
    console.log(serializer.decode('server_message', buffer))
})