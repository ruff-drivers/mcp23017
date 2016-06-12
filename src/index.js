/*
 * Copyright (c) 2015 Nanchao Inc. All rights reserved.
 */
'use strict';

var EventEmitter = require('events');
var driver = require('ruff-driver');
var gpio = require('gpio');
var util = require('util');

var hasOwnProperty = Object.prototype.hasOwnProperty;

var Direction = gpio.Direction;
var Level = gpio.Level;
var Edge = gpio.Edge;

var DIRECTION_OUT_LEVEL_LOW = 2;
var DIRECTION_OUT_LEVEL_HIGH = 3;

/* eslint-disable camelcase */
var DIRECTION_MAP = {
    in: Direction.in,
    out: Direction.out,
    out_low: DIRECTION_OUT_LEVEL_LOW,
    out_high: DIRECTION_OUT_LEVEL_HIGH
};
/* eslint-enable camelcase */

/* eslint-disable no-unused-vars */
var LEVEL_MAP = {
    low: Level.low,
    high: Level.high
};

var IODIR_A = 0x00;
var IODIR_B = 0x01;

var IPOL_A = 0x02;
var IPOL_B = 0x03;

var GPINTEN_A = 0x04;
var GPINTEN_B = 0x05;

var DEFVAL_A = 0x6;
var DEFVAL_B = 0x7;

var INTCON_A = 0x08;
var INTCON_B = 0x09;

var IOCON_A = 0x0a;
var IOCON_B = 0x0b;

var GPPU_A = 0x0c;
var GPPU_B = 0x0d;

var INTF_A = 0x0e;
var INTF_B = 0x0f;

var INTCAP_A = 0x10;
var INTCAP_B = 0x11;

var GPIO_A = 0x12;
var GPIO_B = 0x13;

var OLAT_A = 0x14;
var OLAT_B = 0x15;
/* eslint-enable no-unused-vars */

var OUTPUT_INDEX_MAP = {
    'io-0': 0,
    'io-1': 1,
    'io-2': 2,
    'io-3': 3,
    'io-4': 4,
    'io-5': 5,
    'io-6': 6,
    'io-7': 7,
    'io-8': 8,
    'io-9': 9,
    'io-10': 10,
    'io-11': 11,
    'io-12': 12,
    'io-13': 13,
    'io-14': 14,
    'io-15': 15
};

function I2cGpioInterface(device, index, options) {
    EventEmitter.call(this);

    this._device = device;
    this._index = index;

    this._activeLow = !!options.activeLow;
    this.setDirection(options.direction || Direction.in);

    if (this._direction === Direction.in) {
        this.setEdge(options.edge || Edge.none);
    }
}

util.inherits(I2cGpioInterface, EventEmitter);

/**
 * @param {boolean} activeLow
 */
I2cGpioInterface.prototype.setActiveLow = function (activeLow) {
    this._activeLow = activeLow;
};

I2cGpioInterface.prototype.getActiveLow = function () {
    return this._activeLow;
};

I2cGpioInterface.prototype.setDirection = function (direction, level) {
    if (typeof direction === 'string') {
        direction = DIRECTION_MAP[direction];
    }

    if (direction === Direction.in) {
        this._device.setDirection(this._index, direction);
        this._direction = direction;
    } else {
        if (direction !== Direction.out) {
            level = direction === DIRECTION_OUT_LEVEL_LOW ? Level.low : Level.high;
            direction = Direction.out;
        }

        this._device.setDirection(this._index, direction);
        this._direction = direction;

        if (typeof level === 'string') {
            level = LEVEL_MAP[level];
        }

        if (typeof level === 'number') {
            this._device.write(level ^ this._activeLow);
        }
    }
};

I2cGpioInterface.prototype.getEdge = function () {
    return this._edge;
};

I2cGpioInterface.prototype.setEdge = function (edge) {
    if (typeof edge === 'string') {
        edge = Edge[edge];
    }

    if (typeof edge !== 'number') {
        throw new TypeError('Invalid edge value');
    }

    this._device.setEdge(this._index, edge);
    this._edge = edge;
};

I2cGpioInterface.prototype.read = function () {
    return this._device.read(this._index) ^ this._activeLow;
};

I2cGpioInterface.prototype.write = function (value) {
    value ^= this._activeLow;
    this._device.write(this._index, value);
};

module.exports = driver({
    attach: function (inputs) {
        this._interfaces = [];

        this._gpio = inputs['gpio'];
        this._i2c = inputs['i2c'];

        this.reset();

        var ioConData = 0x40; // 0b01000000

        this._i2c.writeByte(IOCON_A, ioConData);
        this._i2c.writeByte(IOCON_B, ioConData);

        this._gpio.on('interrupt', this._oninterrupt.bind(this));
    },
    detach: function () {
        this.reset();
    },
    getInterface: function (name, options) {
        if (!hasOwnProperty.call(OUTPUT_INDEX_MAP, name)) {
            throw new Error('Invalid interface name "' + name + '"');
        }

        var index = OUTPUT_INDEX_MAP[name];

        var interfaces = this._interfaces;

        if (index in interfaces) {
            return interfaces[index];
        }

        var gpioInterface = new I2cGpioInterface(this, index, options);

        interfaces[index] = gpioInterface;

        this._interfaces = interfaces;

        return gpioInterface;
    },
    exports: {
        _oninterrupt: function () {
            var interruptionBits = (this._i2c.readByte(INTF_B) << 8) | this._i2c.readByte(INTF_A);
            var valueBits = (this._i2c.readByte(INTCAP_B) << 8) | this._i2c.readByte(INTCAP_A);

            var gpios = this._interfaces;

            for (var i = 0; i < gpios.length; i++) {
                if (interruptionBits & (1 << i) && i in gpios) {
                    var gpio = gpios[i];
                    var value = (valueBits >> i) & 1;
                    var edge = gpio.getEdge();

                    if (
                        value && edge === Edge.falling ||
                        !value && edge === Edge.rising
                    ) {
                        continue;
                    }

                    gpio.emit('interrupt', value);
                }
            }
        },
        // reset all pins to output and pull them down.
        reset: function () {
            this._dataA = 0x00;
            this._dataB = 0x00;

            this._dirDataA = 0xff;
            this._dirDataB = 0xff;

            this._edgeDataA = 0x00;
            this._edgeDataB = 0x00;

            var i2c = this._i2c;

            i2c.writeByte(IODIR_A, this._dirDataA);
            i2c.writeByte(IODIR_B, this._dirDataB);

            i2c.writeByte(GPINTEN_A, this._edgeDataA);
            i2c.writeByte(GPINTEN_B, this._edgeDataB);

            i2c.writeByte(OLAT_A, this._dataA);
            i2c.writeByte(OLAT_B, this._dataB);

            i2c.writeByte(INTCON_A, 0x00);
            i2c.writeByte(INTCON_B, 0x00);
        },
        write: function (index, value) {
            var dataKey;
            var address;

            if (index < 8) {
                dataKey = '_dataA';
                address = OLAT_A;
            } else {
                dataKey = '_dataB';
                address = OLAT_B;
            }

            index %= 8;

            if (value) {
                this[dataKey] |= 1 << index;
            } else {
                this[dataKey] &= ~(1 << index);
            }

            this._i2c.writeByte(address, this[dataKey]);
        },
        read: function (index) {
            var offset = index < 8 ? GPIO_A : GPIO_B;
            return this._i2c.readByte(offset) >> index % 8 & 1;
        },
        /**
         * @param {number} index
         * @param {Direction} direction
         */
        setDirection: function (index, direction) {
            var dataKey;
            var address;

            if (index < 8) {
                dataKey = '_dirDataA';
                address = IODIR_A;
            } else {
                dataKey = '_dirDataB';
                address = IODIR_B;
            }

            index %= 8;

            // The Direction enum has `in` as `0` and `out` as `1`,
            // but we are expecting `in` as `1` and `out` as `0`.
            if (direction) {
                this[dataKey] &= ~(1 << index);
            } else {
                this[dataKey] |= 1 << index;
            }

            this._i2c.writeByte(address, this[dataKey]);
        },
        setEdge: function (index, edge) {
            var dataKey;
            var address;

            if (index < 8) {
                dataKey = '_edgeDataA';
                address = GPINTEN_A;
            } else {
                dataKey = '_edgeDataB';
                address = GPINTEN_B;
            }

            index %= 8;

            if (edge === Edge.none) {
                this[dataKey] &= ~(1 << index);
            } else {
                this[dataKey] |= 1 << index;
            }

            this._i2c.writeByte(address, this[dataKey]);
        }
    }
});
