// @flow

import { packUint8ToFloat } from '../shaders/encode_attribute';
import Color from '../style-spec/util/color';
import { register } from '../util/web_worker_transfer';
import { PossiblyEvaluatedPropertyValue } from '../style/properties';
import { StructArrayLayout1f4, StructArrayLayout2f8, StructArrayLayout4f16, LinePatternLayoutArray } from './array_types';
import browser from '../util/browser';

import type Tile from '../source/tile';
import type Context from '../gl/context';
import type {TypedStyleLayer} from '../style/style_layer/typed_style_layer';
import type { CrossfadeParameters } from '../style/style_layer/line_style_layer';
import type {StructArray, StructArrayMember} from '../util/struct_array';
import type VertexBuffer from '../gl/vertex_buffer';
import type Program from '../render/program';
import type {ImagePosition} from '../render/image_atlas';
import type {
    Feature,
    GlobalProperties,
    SourceExpression,
    CompositeExpression
} from '../style-spec/expression';
import type {PossiblyEvaluated} from '../style/properties';

function packColor(color: Color): [number, number] {
    return [
        packUint8ToFloat(255 * color.r, 255 * color.g),
        packUint8ToFloat(255 * color.b, 255 * color.a)
    ];
}

/**
 *  `Binder` is the interface definition for the strategies for constructing,
 *  uploading, and binding paint property data as GLSL attributes. Most style-
 *  spec properties have a 1:1 relationship to shader attribute/uniforms, but
 *  some require multliple values per feature to be passed to the GPU, and in
 *  those cases we bind multiple attributes/uniforms.
 *
 *  It has three implementations, one for each of the three strategies we use:
 *
 *  * For _constant_ properties -- those whose value is a constant, or the constant
 *    result of evaluating a camera expression at a particular camera position -- we
 *    don't need a vertex attribute buffer, and instead use a uniform.
 *  * For data expressions, we use a vertex buffer with a single attribute value,
 *    the evaluated result of the source function for the given feature.
 *  * For composite expressions, we use a vertex buffer with two attributes: min and
 *    max values covering the range of zooms at which we expect the tile to be
 *    displayed. These values are calculated by evaluating the composite expression for
 *    the given feature at strategically chosen zoom levels. In addition to this
 *    attribute data, we also use a uniform value which the shader uses to interpolate
 *    between the min and max value at the final displayed zoom level. The use of a
 *    uniform allows us to cheaply update the value on every frame.
 *
 *  Note that the shader source varies depending on whether we're using a uniform or
 *  attribute. We dynamically compile shaders at runtime to accomodate this.
 *
 * @private
 */
interface Binder<T> {
    statistics: { max: number };
    paintVertexArray?: StructArray;

    populatePaintArray(length: number, feature: Feature): void;
    upload(Context): void;
    destroy(): void;

    defines(): Array<string>;
    isDataDriven(): boolean;

    setUniforms(context: Context,
                program: Program,
                globals: GlobalProperties,
                currentValue: PossiblyEvaluatedPropertyValue<T>): void;

    setTileSpecificUniforms(context: Context,
                program: Program,
                globals: GlobalProperties,
                currentValue: PossiblyEvaluatedPropertyValue<T>,
                tile: ?Tile,
                crossfade: ?CrossfadeParameters): void;
}

class ConstantBinder<T> implements Binder<T> {
    value: T;
    names: Array<string>;
    type: string;
    statistics: { max: number };
    +setTileSpecificUniforms: (Context,
                Program,
                GlobalProperties,
                PossiblyEvaluatedPropertyValue<T>,
                ?Tile) => void;


    constructor(value: T, names: Array<string>, type: string) {
        this.value = value;
        this.names = names;
        this.type = type;
        this.statistics = { max: -Infinity };
    }

    defines() {
        return this.names.map(name => `#define HAS_UNIFORM_u_${name}`);
    }

    isDataDriven() {
        return false;
    }

    populatePaintArray() {}
    upload() {}
    destroy() {}
    setTileSpecificUniforms() {}

    setUniforms(context: Context,
                program: Program,
                globals: GlobalProperties,
                currentValue: PossiblyEvaluatedPropertyValue<T>) {
        const value: any = currentValue.constantOr(this.value);
        const gl = context.gl;
        for (let i = 0; i < this.names.length; i++) {
            const name = this.names[i];
            if (this.type === 'color') {
                gl.uniform4f(program.uniforms[`u_${name}`], value.r, value.g, value.b, value.a);
            } else {
                gl.uniform1f(program.uniforms[`u_${name}`], value);
            }
        }
    }

}

class PatternConstantBinder<T> extends ConstantBinder<T> {
    setTileSpecificUniforms(context: Context,
                            program: Program,
                            globals: GlobalProperties,
                            currentValue: PossiblyEvaluatedPropertyValue<T>,
                            tile: ?Tile) {
        const image: any = currentValue.constantOr(this.value);
        const gl = context.gl;
        if (image && tile && tile.iconAtlas) {
            const imagePosMin = tile.iconAtlas.positions[image.min],
                imagePosMid = tile.iconAtlas.positions[image.mid],
                imagePosMax = tile.iconAtlas.positions[image.max];
            if (!imagePosMin || !imagePosMid || !imagePosMax) return;
            gl.uniform4fv(program.uniforms.u_pattern_min, (imagePosMin: any).tl.concat((imagePosMin: any).br));
            gl.uniform4fv(program.uniforms.u_pattern_mid, (imagePosMid: any).tl.concat((imagePosMid: any).br));
            gl.uniform4fv(program.uniforms.u_pattern_max, (imagePosMax: any).tl.concat((imagePosMax: any).br));
            // this assumes all images in the icon atlas texture have the same pixel ratio
            if (globals.tileRatio) gl.uniform4f(program.uniforms.u_scale, imagePosMid.pixelRatio, globals.tileRatio, image.fromScale, image.toScale);
            gl.uniform1f(program.uniforms.u_fade, image.t);
            gl.uniform1i(program.uniforms.u_zoomin, image.fromScale === 2 ? 1 : 0);

            gl.uniform1i(program.uniforms.u_image, 0);
            context.activeTexture.set(gl.TEXTURE0);
            tile.iconAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            gl.uniform2fv(program.uniforms.u_texsize, tile.iconAtlasTexture.size);
        }
    }

    setUniforms() {}
}

class SourceExpressionBinder<T> implements Binder<T> {
    expression: SourceExpression;
    names: Array<string>;
    type: string;
    statistics: { max: number };

    paintVertexArray: StructArray;
    paintVertexAttributes: Array<StructArrayMember>;
    paintVertexBuffer: ?VertexBuffer;

    constructor(expression: SourceExpression, names: Array<string>, type: string, layout: Class<StructArray>) {
        this.expression = expression;
        this.names = names;
        this.type = type;
        this.statistics = { max: -Infinity };
        const PaintVertexArray = layout;
        this.paintVertexAttributes = names.map((name) =>
            ({
                name: `a_${name}`,
                type: 'Float32',
                components: type === 'color' ? 2 : 1,
                offset: 0
            })
        );
        this.paintVertexArray = new PaintVertexArray();
    }

    defines() {
        return [];
    }

    isDataDriven() {
        return true;
    }

    populatePaintArray(length: number, feature: Feature) {
        const paintArray = this.paintVertexArray;

        const start = paintArray.length;
        paintArray.reserve(length);

        const value = this.expression.evaluate({zoom: 0}, feature);

        // figure out how to design this for atypical paint properties with multiple attributes
        if (this.type === 'color') {
            const color = packColor(value);
            for (let i = start; i < length; i++) {
                paintArray.emplaceBack(color[0], color[1]);
            }
        } else {
            for (let i = start; i < length; i++) {
                paintArray.emplaceBack(value);
            }

            this.statistics.max = Math.max(this.statistics.max, value);
        }
    }

    upload(context: Context) {
        if (this.paintVertexArray) {
            this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes);
        }
    }

    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }

    setUniforms(context: Context, program: Program) {
        context.gl.uniform1f(program.uniforms[`a_${this.names[0]}_t`], 0);
    }

    setTileSpecificUniforms() {}
}

class CompositeExpressionBinder<T> implements Binder<T> {
    expression: CompositeExpression;
    names: Array<string>;
    type: string;
    useIntegerZoom: boolean;
    zoom: number;
    statistics: { max: number };

    paintVertexArray: StructArray;
    paintVertexAttributes: Array<StructArrayMember>;
    paintVertexBuffer: ?VertexBuffer;
    +populatePaintArrays: (number, Feature, ?{[string]: ImagePosition}) => void;
    +setTileSpecificUniforms: (Context,
                Program,
                GlobalProperties,
                PossiblyEvaluatedPropertyValue<T>,
                ?Tile,
                ?CrossfadeParameters) => void;

    constructor(expression: CompositeExpression, names: Array<string>, type: string, useIntegerZoom: boolean, zoom: number, layout: Class<StructArray>) {
        this.expression = expression;
        this.names = names;
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.statistics = { max: -Infinity };
        const PaintVertexArray = layout;
        this.paintVertexAttributes = names.map((name) => {
            return {
                name: `a_${name}`,
                type: 'Float32',
                components: type === 'color' ? 4 : 2,
                offset: 0
            };
        });
        this.paintVertexArray = new PaintVertexArray();
    }

    defines() {
        return [];
    }

    isDataDriven() {
        return true;
    }

    populatePaintArray(length: number, feature: Feature) {
        const paintArray = this.paintVertexArray;

        const start = paintArray.length;
        paintArray.reserve(length);

        const min = this.expression.evaluate({zoom: this.zoom    }, feature);
        const max = this.expression.evaluate({zoom: this.zoom + 1}, feature);

        // figure out how to design this for atypical paint properties with multiple attributes
        if (this.type === 'color') {
            const minColor = packColor(min);
            const maxColor = packColor(max);
            for (let i = start; i < length; i++) {
                paintArray.emplaceBack(minColor[0], minColor[1], maxColor[0], maxColor[1]);
            }
        } else {
            for (let i = start; i < length; i++) {
                paintArray.emplaceBack(min, max);
            }

            this.statistics.max = Math.max(this.statistics.max, min, max);
        }
    }

    upload(context: Context) {
        if (this.paintVertexArray) {
            this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes);
        }
    }

    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }

    interpolationFactor(currentZoom: number) {
        if (this.useIntegerZoom) {
            return this.expression.interpolationFactor(Math.floor(currentZoom), this.zoom, this.zoom + 1);
        } else {
            return this.expression.interpolationFactor(currentZoom, this.zoom, this.zoom + 1);
        }
    }

    setUniforms(context: Context, program: Program, globals: GlobalProperties) {
        context.gl.uniform1f(program.uniforms[`a_${this.names[0]}_t`], this.interpolationFactor(globals.zoom));
    }

    setTileSpecificUniforms() {}
}

class PatternCompositeExpressionBinder<T> extends CompositeExpressionBinder<T> {
    constructor(expression: CompositeExpression, names: Array<string>, type: string, useIntegerZoom: boolean, zoom: number, layout: Class<StructArray>) {
        super(expression, names, type, useIntegerZoom, zoom, layout);
        const PaintVertexArray = layout;
        this.paintVertexAttributes = names.map((name) =>
            ({
                name: `a_${name}`,
                type: 'Float32',
                components: 4,
                offset: 0
            })
        );
        this.paintVertexArray = new PaintVertexArray();
    }

    populatePaintArray(length: number, feature: Feature, imagePositions: ?{[string]: ImagePosition}) {
        const paintArray = this.paintVertexArray;

        const start = paintArray.length;
        paintArray.reserve(length);

        const min = this.expression.evaluate({zoom: this.zoom - 1}, feature);
        const mid = this.expression.evaluate({zoom: this.zoom }, feature);
        const max = this.expression.evaluate({zoom: this.zoom + 1}, feature);

        if (imagePositions) {
            const imageMin = imagePositions[min];
            const imageMid = imagePositions[mid];
            const imageMax = imagePositions[max];

            if (!imageMin || !imageMid || !imageMax) return;
            // will delete this once we decide on a packing strategy for line-pattern
            // const minTL = packUint8ToFloat(imageMin.tl[0], imageMin.tl[1]);
            // const minBR = packUint8ToFloat(imageMin.br[0], imageMin.br[1]);
            // const midTL = packUint8ToFloat(imageMid.tl[0], imageMid.tl[1]);
            // const midBR = packUint8ToFloat(imageMid.br[0], imageMid.br[1]);
            // const maxTL = packUint8ToFloat(imageMax.tl[0], imageMax.tl[1]);
            // const maxBR = packUint8ToFloat(imageMax.br[0], imageMax.br[1]);

            for (let i = start; i < length; i++) {
                paintArray.emplaceBack(
                    // minTL, minBR,
                    // midTL, midBR,
                    // maxTL, maxBR
                    imageMin.tl[0], imageMin.tl[1], imageMin.br[0], imageMin.br[1],
                    imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1],
                    imageMax.tl[0], imageMax.tl[1], imageMax.br[0], imageMax.br[1]
                );
            }
        }
    }

    setTileSpecificUniforms(context: Context,
                            program: Program,
                            globals: GlobalProperties,
                            currentValue: PossiblyEvaluatedPropertyValue<T>,
                            tile: ?Tile,
                            crossfade: ?CrossfadeParameters) {

        if (tile && crossfade) {
            const gl = context.gl;
            gl.uniform1f(program.uniforms.u_fade, crossfade.t);
            gl.uniform1i(program.uniforms.u_zoomin, crossfade.fromScale === 2 ? 1 : 0);

            // find a better way to determine pixel ratio of tile iconAtlas images
            if (globals.tileRatio) gl.uniform4f(program.uniforms.u_scale, browser.devicePixelRatio > 1 ? 2 : 1, globals.tileRatio, crossfade.fromScale, crossfade.toScale);

            gl.uniform1i(program.uniforms.u_image, 0);
            context.activeTexture.set(gl.TEXTURE0);
            tile.iconAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            gl.uniform2fv(program.uniforms.u_texsize, tile.iconAtlasTexture.size);
        }
    }

    setUniforms() {}
}

/**
 * ProgramConfiguration contains the logic for binding style layer properties and tile
 * layer feature data into GL program uniforms and vertex attributes.
 *
 * Non-data-driven property values are bound to shader uniforms. Data-driven property
 * values are bound to vertex attributes. In order to support a uniform GLSL syntax over
 * both, [Mapbox GL Shaders](https://github.com/mapbox/mapbox-gl-shaders) defines a `#pragma`
 * abstraction, which ProgramConfiguration is responsible for implementing. At runtime,
 * it examines the attributes of a particular layer, combines this with fixed knowledge
 * about how layers of the particular type are implemented, and determines which uniforms
 * and vertex attributes will be required. It can then substitute the appropriate text
 * into the shader source code, create and link a program, and bind the uniforms and
 * vertex attributes in preparation for drawing.
 *
 * When a vector tile is parsed, this same configuration information is used to
 * populate the attribute buffers needed for data-driven styling using the zoom
 * level and feature property data.
 *
 * @private
 */
export default class ProgramConfiguration {
    binders: { [string]: Binder<any> };
    cacheKey: string;
    layoutAttributes: Array<StructArrayMember>;

    _buffers: Array<VertexBuffer>;

    constructor() {
        this.binders = {};
        this.cacheKey = '';

        this._buffers = [];
    }

    static createDynamic<Layer: TypedStyleLayer>(layer: Layer, zoom: number, filterProperties: (string) => boolean) {
        const self = new ProgramConfiguration();
        const keys = [];

        for (const property in layer.paint._values) {
            if (!filterProperties(property)) continue;
            const value = layer.paint.get(property);
            if (!(value instanceof PossiblyEvaluatedPropertyValue) || !value.property.specification['property-function']) {
                continue;
            }
            const names = paintAttributeName(property, layer.type);
            const type = value.property.specification.type;
            const useIntegerZoom = value.property.useIntegerZoom;

            if (value.value.kind === 'constant') {
                if (property.match(/line-pattern/)) {
                    self.binders[property] = new PatternConstantBinder(value.value, names, type);
                } else {
                    self.binders[property] = new ConstantBinder(value.value, names, type);
                }
                keys.push(`/u_${property}`);
            } else if (property.match(/line-pattern/)) {
                const structArrayLayout = layoutType(property, type, 'source');
                self.binders[property] = new PatternCompositeExpressionBinder(value.value, names, type, useIntegerZoom, zoom, structArrayLayout);
                keys.push(`/p_${property}`);
            } else if (value.value.kind === 'source') {
                const structArrayLayout = layoutType(property, type, 'source');
                self.binders[property] = new SourceExpressionBinder(value.value, names, type, structArrayLayout);
                keys.push(`/a_${property}`);
            } else {
                const structArrayLayout = layoutType(property, type, 'composite');
                self.binders[property] = new CompositeExpressionBinder(value.value, names, type, useIntegerZoom, zoom, structArrayLayout);
                keys.push(`/z_${property}`);
            }
        }

        self.cacheKey = keys.sort().join('');

        return self;
    }

    populatePaintArrays(length: number, feature: Feature, imagePositions: ?{[string]: ImagePosition}) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof PatternCompositeExpressionBinder) {
                binder.populatePaintArray(length, feature, imagePositions);
            } else {
                binder.populatePaintArray(length, feature);
            }
        }
    }

    defines(): Array<string> {
        const result = [];
        for (const property in this.binders) {
            result.push.apply(result, this.binders[property].defines());
        }
        return result;
    }

    setUniforms<Properties: Object>(context: Context, program: Program, properties: PossiblyEvaluated<Properties>, globals: GlobalProperties) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            binder.setUniforms(context, program, globals, properties.get(property));
        }
    }

    setTileSpecificUniforms<Properties: Object>(context: Context, program: Program, properties: PossiblyEvaluated<Properties>, globals: GlobalProperties, tile: ?Tile, crossfade: ?CrossfadeParameters) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            binder.setTileSpecificUniforms(context, program, globals, properties.get(property), tile, crossfade);
        }
    }

    getPaintVertexBuffers(): Array<VertexBuffer> {
        return this._buffers;
    }

    upload(context: Context) {
        for (const property in this.binders) {
            this.binders[property].upload(context);
        }

        const buffers = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if ((binder instanceof SourceExpressionBinder ||
                binder instanceof CompositeExpressionBinder ||
                binder instanceof PatternCompositeExpressionBinder) &&
                binder.paintVertexBuffer
            ) {
                buffers.push(binder.paintVertexBuffer);
            }
        }
        this._buffers = buffers;
    }

    destroy() {
        for (const property in this.binders) {
            this.binders[property].destroy();
        }
    }
}

export class ProgramConfigurationSet<Layer: TypedStyleLayer> {
    programConfigurations: {[string]: ProgramConfiguration};

    constructor(layoutAttributes: Array<StructArrayMember>, layers: $ReadOnlyArray<Layer>, zoom: number, filterProperties: (string) => boolean = () => true) {
        this.programConfigurations = {};
        for (const layer of layers) {
            this.programConfigurations[layer.id] = ProgramConfiguration.createDynamic(layer, zoom, filterProperties);
            this.programConfigurations[layer.id].layoutAttributes = layoutAttributes;
        }
    }

    populatePaintArrays(length: number, feature: Feature, imagePositions: ?{[string]: ImagePosition}) {
        for (const key in this.programConfigurations) {
            this.programConfigurations[key].populatePaintArrays(length, feature, imagePositions);
        }
    }

    get(layerId: string) {
        return this.programConfigurations[layerId];
    }

    upload(context: Context) {
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].upload(context);
        }
    }

    destroy() {
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].destroy();
        }
    }
}

// paint property arrays
function paintAttributeName(property, type) {
    const attributeNameExceptions = {
        'text-opacity': ['opacity'],
        'icon-opacity': ['opacity'],
        'text-color': ['fill_color'],
        'icon-color': ['fill_color'],
        'text-halo-color': ['halo_color'],
        'icon-halo-color': ['halo_color'],
        'text-halo-blur': ['halo_blur'],
        'icon-halo-blur': ['halo_blur'],
        'text-halo-width': ['halo_width'],
        'icon-halo-width': ['halo_width'],
        'line-gap-width': ['gapwidth'],
        'line-pattern': ['pattern_min', 'pattern_mid', 'pattern_max']
    };
    return attributeNameExceptions[property] ||
        [property.replace(`${type}-`, '').replace(/-/g, '_')];
}

function getLayoutException(property) {
    const propertyExceptions = {
        'line-pattern':{
            'source': LinePatternLayoutArray,
            'composite': LinePatternLayoutArray
        }
    };

    return propertyExceptions[property];
}

function layoutType(property, type, binderType) {
    const defaultLayouts = {
        'color': {
            'source': StructArrayLayout2f8,
            'composite': StructArrayLayout4f16
        },
        'number': {
            'source': StructArrayLayout1f4,
            'composite': StructArrayLayout2f8
        }
    };

    const layoutException = getLayoutException(property);
    return  layoutException && layoutException[binderType] ||
        defaultLayouts[type][binderType];
}

register('ConstantBinder', ConstantBinder);
register('PatternConstantBinder', PatternConstantBinder);
register('SourceExpressionBinder', SourceExpressionBinder);
register('PatternCompositeExpressionBinder', PatternCompositeExpressionBinder);
register('CompositeExpressionBinder', CompositeExpressionBinder);
register('ProgramConfiguration', ProgramConfiguration, {omit: ['_buffers']});
register('ProgramConfigurationSet', ProgramConfigurationSet);
