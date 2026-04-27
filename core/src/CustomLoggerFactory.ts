import { ConsoleLogReporter, LoggerFactory } from '@toolcase/logging'

class CustomLoggerFactory extends LoggerFactory {

    static Instance: CustomLoggerFactory

    constructor() {
        super([
            new ConsoleLogReporter()
        ])
    }
}

CustomLoggerFactory.Instance = new CustomLoggerFactory()

export default CustomLoggerFactory
